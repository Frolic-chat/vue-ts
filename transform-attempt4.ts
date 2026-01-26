import * as ts from 'typescript';

/**
 * TYPES
 */
type ComputedProperty = {
    get?: ts.AccessorDeclaration;
    set?: ts.AccessorDeclaration;
};

type ComputedProperties = {
    [key: string]: ComputedProperty;
};

type WatchProperties = {
    [key: string]: ts.ObjectLiteralExpression[];
};

type HookProperties = {
    // Could this be less generic?
    [key: string]: ts.Expression[];
};

/**
 * Provides deep evaluation of a decorator expression's name.
 * @param decorator
 * @returns `getText` of internal expression if this is a call, otherwise `getText` of current expression.
 */
function getDecoratorName(
    decorator: ts.Decorator
): string
{
    const expr = decorator.expression;

    return ts.isCallExpression(expr)
        ? expr.expression.getText(decorator.getSourceFile())
        : expr.getText(decorator.getSourceFile());
}

/**
 * Evaluates whether decorator is a call and returns an argument from it if it is
 * @param decorator
 * @param index argument number to return
 * @returns Argument `index` of the decorator if its a call expression; otherwise undefined.
 */
function getDecoratorArgument(
    decorator: ts.Decorator,
    index: number
): ts.Expression | undefined
{
    return ts.isCallExpression(decorator.expression)
        ? decorator.expression.arguments[index]
        : undefined;
}

/**
 * Takes a name and getter/setters from a computed map and creates a property assignment
 * @param key
 * @param param1
 * @returns A key: { get, set } property
 */
function computedToProperty(
    key: string,
    { get, set }: ComputedProperty
): ts.PropertyAssignment
{
    if (!get)
        throw new Error(`No getter defined for ${key}`);

    if (get.parameters.length) {
        // nonfatal
        console.warn(`Parameters on ${key} getter will be ignored.`);
    }

    // Add vue getter from computed property
    const get_func = ts.factory.createMethodDeclaration(undefined, undefined, 'get', undefined, undefined, [], get.type, get.body);

    // Add vue setter from computed property
    let set_func: ts.MethodDeclaration | undefined;
    if (set) {
        set_func = ts.factory.createMethodDeclaration(undefined, undefined, 'set', undefined, undefined, set.parameters, set.type, set.body);
    }

    const method_container = ts.factory.createObjectLiteralExpression(
        [
            get_func,
            ...(set_func ? [ set_func ] : [])
        ]
    );

    return ts.factory.createPropertyAssignment(
        ts.factory.createStringLiteral(key),
        method_container
    );
}

/**
 * Takes a name and handler array from a watch map and returns a property assignment
 * @param key
 * @param param1
 * @returns A key: array property
 */
function watchToProperty(
    key: string,
    handlers: ts.ObjectLiteralExpression[]
): ts.PropertyAssignment
{
    const array_of_handlers = ts.factory.createArrayLiteralExpression(
        handlers
    );

    return ts.factory.createPropertyAssignment(
        ts.factory.createStringLiteral(key),
        array_of_handlers
    )
}

/**
 * Perform shenanigans to convert a hook -> (method name)[] map into a call `hook() { method1.apply(); ... }`
 * @param key
 * @param param1
 * @returns
 */
function hookToMethod(
    key: string,
    methods: ts.Expression[]
): ts.MethodDeclaration
{
    const box_of_apply_calls: ts.ExpressionStatement[] = [];

    for (const method of methods) {
        const access = ts.factory.createElementAccessExpression(
            ts.factory.createThis(),
            method
        );

        const apply_access = ts.factory.createPropertyAccessExpression(
            access,
            'apply'
        );

        const call_of_apply = ts.factory.createCallExpression(
            apply_access,
            undefined,
            [
                ts.factory.createThis(),
                ts.factory.createIdentifier('arguments')
            ]
        )

        const final_call = ts.factory.createExpressionStatement(call_of_apply);

        box_of_apply_calls.push(final_call);
    }

    // Turn the box into a method.
    const method = ts.factory.createMethodDeclaration(
        undefined,
        undefined,
        key,
        undefined,
        undefined,
        [],
        undefined,
        ts.factory.createBlock(box_of_apply_calls)
    )

    return method;
}

// function replaceIfSuper(
//     node: ts.Node,
//     base: ts.ExpressionWithTypeArguments
// ): void {
    // starting at method declaration, loop all children:
    // find child who matches:
    // parent: call expression
    // us (replace-able): (property or element) AND .expression.kind = SuperKeyword
    // Does not recurse deeper if this is a Super, otherwise recurses.
// }



/**
 * Goals of the visitor:
 * 1. Find component decorator.
 *
 * 2. Construct the big six:
 *    data, methods, props, computed, watch, hooks
 *
 * 3. Iterate non-abstract members:
 *
 * 3a. get/set, turn into computed.
 *
 * 3b. @Prop decorator:
 *     copy to props (skip $),
 *     add undefined initializer
 *
 * 3c. Methods:
 *     Replace Super.x() calls
 *     @Hook decorator:
 *       Add Hook name -> method alias/wrapper into data object
 *     @Watch decorator:
 *       Create handler object
 *       Add handler to watch object
 *     Stuff methods into methods object
 *
 * 4. Turn collections into actual properties
 *    computed: object of get/set
 *    hooks: methods already in data
 *    watch: watched key(?) to handler[]
 *
 * 5. Build 'options' object - merge everything.
 *
 * 6. Create replacement class and export as default.
 *    Return it as replacement node.
 */
const visitor: ts.Visitor = node => {
    /**
     * Step 1: This is a class, right?
     */

    const component_decorator = ts.canHaveDecorators(node)
        ? ts.getDecorators(node)?.find(dec => getDecoratorName(dec) === 'Component')
        : undefined;

    // Type-narrows node to ts.ClassDeclaration
    if (!component_decorator || !ts.isClassDeclaration(node))
        return node;

    // Get the left-side of the extends statement or cleanly handle absence of extends.
    const extendsFromVueState = node.heritageClauses?.find(clause => clause.token === ts.SyntaxKind.ExtendsKeyword)?.types[0];

    if (!extendsFromVueState)
        throw new Error(`Class component must extend Vue or a Vue component.`);

    /**
     * Step 2: Boxes to hold things.
     */

    const existing_component_data_arg = getDecoratorArgument(component_decorator, 0);

    // AST node array of the options explicitly provided to .
    const existingProperties = existing_component_data_arg && ts.isObjectLiteralExpression(existing_component_data_arg)
        ? [ ...(existing_component_data_arg.properties) ]
        : [];

    const dataList: ts.ObjectLiteralElementLike[] = [],
        methodList: ts.ObjectLiteralElementLike[] = [],
          propList: ts.ObjectLiteralElementLike[] = [];

    const computedMap: ComputedProperties = {},
             watchMap: WatchProperties = {},
             hooksMap: HookProperties = {};

    /**
     * Step 3: Iterate non-abstracts
     */

    for (const member of node.members) {
        const member_modifiers = ts.canHaveModifiers(member)
            ? ts.getModifiers(member)
            : undefined;

        if (member_modifiers?.some(mod => mod.kind === ts.SyntaxKind.AbstractKeyword))
            continue;

        /**
         * Step 3a: Computed properties
         */
        if (ts.isAccessor(member)) {
            const key = member.name.getText();

            const entry = computedMap[key] || (computedMap[key] = {});

            if (ts.isGetAccessor(member))
                entry.get = member;
            else // if (ts.isSetAccessor(member))
                entry.set = member;

            // New methods are created for the getter/setter in the transformer, but the current method is added to the methods object, so do we need to not add to the methods object until after transformation?
            // Consult the original version of the code for flow.
        }
        /**
         * Step 3b: @Prop decorators, Vue internal properties, and data (undecorated) properties
         */
        else if (ts.isPropertyDeclaration(member)) {
            const member_decorators = ts.canHaveDecorators(member)
                ? ts.getDecorators(member)
                : undefined;

            const prop_decorator = member_decorators?.find(dec => getDecoratorName(dec) === 'Prop');

            if (prop_decorator) {
                const prop_data = getDecoratorArgument(prop_decorator, 0);

                const prop_body = prop_data && ts.isObjectLiteralExpression(prop_data)
                    ? prop_data
                    : ts.factory.createObjectLiteralExpression();

                const our_prop = ts.factory.createPropertyAssignment(
                    member.name,
                    prop_body
                );

                propList.push(our_prop);
            }
            else if (member.name.getText().charAt(0) === '$') {
                continue; // Skip vue internal data
            }
            else {
                const our_data = ts.factory.createPropertyAssignment(
                    member.name,
                    member.initializer ?? ts.factory.createIdentifier('undefined')
                );

                dataList.push(our_data);
            }
        }
        /**
         * Step 3b: Methods, including @Hook and @Watch decorators
         */
        else if (ts.isMethodDeclaration(member)) {
            /**
             * Super call replacement goes here.
             * This should morph the method declaration, and thus we need to track the resulting modified method.
             * Probably pull out all children one by one? Updating needy children as we encounter them.
             *
             * May still need "super is child of expression that isn't a CallExpression" error.
             */
            ts.forEachChild(member, node => {
                if (ts.isCallExpression(node)) {
                    // nonfatal
                    console.log(`Elligible for child-might-be-super check: ${node.expression.getText() ?? 'Unknown Left Side'}`);
                }
                else {
                    ts.forEachChild(node, _child => undefined /* this function (recurse) */);
                }
            });

            const hook_decorators = ts.canHaveDecorators(member)
                ? ts.getDecorators(member)?.filter(x => getDecoratorName(x) === 'Hook') ?? []
                : [];

            for (const hook of hook_decorators) {
                const name_arg = getDecoratorArgument(hook, 0);

                if (!name_arg || !ts.isStringLiteral(name_arg) || !name_arg.text)
                    throw new Error(`Malformed Hook decorator name: ${name_arg?.getText() || 'Empty String'}`);

                const lifecycle_key = name_arg.text;

                // lifecycle key -> member.name[] map
                // (Run all these members on that lifecycle event)
                const lc_to_namearray_map = hooksMap[lifecycle_key] || (hooksMap[lifecycle_key] = []);

                let member_name: ts.Expression;

                if (ts.isLiteralExpression(member.name))
                    member_name = member.name;
                else if (ts.isIdentifier(member.name))
                    member_name = ts.factory.createStringLiteralFromNode(member.name)
                else if (ts.isComputedPropertyName(member.name))
                    member_name = member.name.expression;
                else // if (ts.isPrivateIdentifier(member.name))
                    member_name = member.name;

                lc_to_namearray_map.push(member_name);
            }

            const watch_decorators = ts.canHaveDecorators(member)
                ? ts.getDecorators(member)?.filter(dec => getDecoratorName(dec) === 'Watch') ?? []
                : [];

            for (const watch of watch_decorators) {
                const name_arg = getDecoratorArgument(watch, 0);

                if (!name_arg || !ts.isStringLiteral(name_arg) || !name_arg.text)
                    throw new Error(`Malformed Watch decorator key: ${name_arg?.getText() || 'Empty String'}`);

                const watched_key = name_arg.text;

                // `handler: <member.name>`
                const handler_property = ts.factory.createPropertyAssignment(
                    ts.factory.createIdentifier('handler'),
                    ts.factory.createStringLiteral(member.name.getText())
                );

                // `{ immediate: true, deep: true }`
                const d = getDecoratorArgument(watch, 1);
                const watch_data = d && ts.isObjectLiteralExpression(d)
                    ? d
                    : { properties: [] };

                const handler = ts.factory.createObjectLiteralExpression([
                    handler_property,
                    ...watch_data.properties
                ]);


                // watched member key -> handler[] map
                // (run these handlers when this key is changed)
                const key_to_handler_map = watchMap[watched_key] || (watchMap[watched_key] = []);

                key_to_handler_map.push(handler);
            }

            // In the original, we copied member into methods object here.
            // We still have to do that, but the decorators need to be cleaned.
            // When the Super-child transformer works, this is a place we can reassemble the modified children.
            const modified_member = ts.factory.updateMethodDeclaration(
                member,
                member.modifiers, // leaving out member.decorators
                member.asteriskToken,
                member.name,
                member.questionToken,
                member.typeParameters,
                member.parameters,
                member.type,
                member.body
            );

            methodList.push(modified_member);
        }
    }

    /**
     * 4. Turn collections into actual properties
     * If we want to COMBINE preexisting data and the data from class structure parsing, that's a bonus feature we haven't implemented. So class will always override whatever was in the preexisting.
     */
    // 4a. Computed:
    // We have:
    //     computedMap[key] = { get: function, set: function }
    // We want:
    //     object of { key: { get, set } }
    const computed_properties = Object.entries(computedMap)
        .map(([ key, getAndSet ]) => computedToProperty(key, getAndSet));

    // THIS OBJECT is the one we can use during node reconstruction.
    const computedProperty = ts.factory.createPropertyAssignment(
        ts.factory.createStringLiteral('computed'),
        // `name: { get, set }`
        ts.factory.createObjectLiteralExpression(computed_properties)
    );

    // 4b. Watch:
    // We have:
    //     watchMap[key] = { handler: function[], deep: boolean, immediate: boolean }
    // We want:
    //     object of { key: { handler, deep, immediate } }
    //
    const watched_properties = Object.entries(watchMap)
        .map(([ key, handlers ]) => watchToProperty(key, handlers));

    const watchProperty = ts.factory.createPropertyAssignment(
        ts.factory.createStringLiteral('watch'),
        ts.factory.createObjectLiteralExpression(watched_properties)
    );

    // 4c. Lifecycle hooks:
    // We have:
    //     hooksMap = { lifecycle: [ methodName: function ] }
    // We want:
    //     hook() { 1.apply(); 2.apply(); }
    //
    const lifecycles = Object.entries(hooksMap)
        .map(([ lifecycle, methods ]) => hookToMethod(lifecycle, methods));

    /**
     * Step 5: Avengers assemble!
     */

    const data_return = ts.factory.createReturnStatement(
        ts.factory.createObjectLiteralExpression(dataList)
    );

    const options_body = ts.factory.createBlock([
            data_return
    ]);

    const dataOption = ts.factory.createMethodDeclaration(
        [],
        undefined,
        'data',
        undefined,
        undefined,
        [],
        undefined,
        options_body
    );

    const propsOption = ts.factory.createPropertyAssignment(
        ts.factory.createIdentifier('props'),
        ts.factory.createObjectLiteralExpression(propList)
    )

    const methodsOptions = ts.factory.createPropertyAssignment(
        ts.factory.createIdentifier('methods'),
        ts.factory.createObjectLiteralExpression(methodList)
    )

    const finalOptionsObject = ts.factory.createObjectLiteralExpression([
        ...existingProperties,  // components
        dataOption,             // data
        propsOption,            // props
        methodsOptions,         // methods
        watchProperty,          // watch
        computedProperty,       // computed
        ...lifecycles           // hooks
    ]);

    const const_modifier = ts.factory.createModifier(ts.SyntaxKind.ConstKeyword);

    const base_property = ts.factory.createPropertyAccessExpression(
        extendsFromVueState.expression,
        ts.factory.createIdentifier('extend')
    );

    const call_init = ts.factory.createCallExpression(
        base_property,
        undefined,
        [ finalOptionsObject ]
    )

    const class_variable = ts.factory.createVariableDeclaration(
        node.name!,
        undefined,
        undefined,
        call_init
    );

    return [
        ts.factory.createVariableStatement(
            [ const_modifier ],
            [ class_variable ]
        ),
        ts.factory.createExportDefault(node.name!)
    ];
};

const transformer: ts.TransformerFactory<ts.SourceFile> = context => {
    return node => ts.visitEachChild(node, visitor, context);
};

export default transformer;
