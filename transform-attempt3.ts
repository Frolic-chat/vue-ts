import * as ts from 'typescript';

/**
 * TYPES
 */
type ComputedProperties = {
    [key: string]: ComputedProperty,
};

type WatchProperties = {
    [key: string]: ts.ObjectLiteralExpression[];
};

type HookProperties = {
    [key: string]: ts.Expression[];
};

type ComputedProperty = {
    get?: ts.AccessorDeclaration;
    set?: ts.AccessorDeclaration;
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
    return ts.isCallExpression(decorator.expression)
        ? decorator.expression.expression.getText(decorator.getSourceFile())
        : decorator.expression.getText(decorator.getSourceFile());
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
 * Return a modified version of the provided object with the expression added to its properties.
 * @param object Base object to copy
 * @param expr New property to add
 * @returns New object with `expr` added.
 */
function copyWithAddedProperty(
    object: ts.ObjectLiteralExpression,
    expr: ts.ObjectLiteralElementLike,
): ts.ObjectLiteralExpression
{
    // Old:
    // (<ts.ObjectLiteralElementLike[]><unknown>object.properties).push(expr);

    const new_props = ts.factory.createNodeArray([...object.properties, expr]);

    return ts.factory.updateObjectLiteralExpression(object, new_props);
}

/**
 * Provides evaluation of `object | undefined`
 *
 * Creates a new object with properties copied from the provided object. If it's not an object, return undefined.
 * @param object Object to copy properties from
 * @returns A new object with properties from the provided object; if the object doesn't exist, our copy doesn't exist either.
 */
function copyIfObject(
    object: ts.Node | undefined
): ts.ObjectLiteralExpression
{
    return ts.factory.createObjectLiteralExpression(
        object && ts.isObjectLiteralExpression(object)
            ? object.properties
            : undefined
    );
}

function handleComputedProperty(
    key: string,
    value: ComputedProperty
): ts.Expression
{
    if (!value.get)
        throw new Error("No getter defined for " + key);

    // Add vue getter from computed property
    const get_func = ts.factory.createMethodDeclaration(undefined, undefined, 'get', undefined, undefined, [], undefined, value.get.body);

    // Add vue setter from computed property
    let set_func: ts.MethodDeclaration | undefined;
    if (value.set) {
        set_func = ts.factory.createMethodDeclaration(undefined, undefined, 'set', undefined, undefined, value.set.parameters, undefined, value.set.body);
    }

    return ts.factory.createObjectLiteralExpression([ get_func, ...(set_func ? [ set_func ] : []) ]);
}

/**
 * Crawl the node tree replacing calls to super with...?
 * @param node Root for crawling
 * @param base Type of `base` is acquired purely by copying TS compiler's suggestion based on usage; possibly it could be expanded.
 *
 * @throws Error If `super` keyword is found outside of being called.
 */
function replaceIfSuper(
    node: ts.Node,
    base: ts.ExpressionWithTypeArguments
): void
{
    if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && node.expression.kind === ts.SyntaxKind.SuperKeyword) {
        if (!ts.isCallExpression(node.parent))
            throw new Error('The super keyword is only supported in call expressions.');

        // Needs fix - expression is readonly
        node.expression = ts.factory.createPropertyAccessExpression(
            ts.factory.createPropertyAccessExpression(base.expression, 'options'),
            'methods'
        );

        // Needs fix - expression is readonly
        node.parent.expression = ts.factory.createPropertyAccessExpression(node, 'call');

        // Needs fix - remove casts, likely readonly
        (<ts.Expression[]><unknown>node.parent.arguments).unshift(ts.factory.createThis());
    }
    else {
        ts.forEachChild(node, node => replaceIfSuper(node, base));
    }
}

/**
 * Returns a new object with properties derived from `entries`. Provided iterator function is responsible for converting entries into props.
 * @param object
 * @param entries
 * @param name Name of the new property added to `object`
 * @param iterator k-v pair => `PropertyAssignment[]`
 * @returns Same object is no entries; otherwise new object with new properties
 */
function addEntriesAsProperties<T>(
    object: ts.ObjectLiteralExpression,
    entries: { [key: string]: T },
    name: string,
    iterator: (key: string, value: T) => ts.Expression
): ts.ObjectLiteralExpression
{
    const keys = Object.keys(entries);
    if (!keys.length)
        return object;

    const properties = keys.map(x =>
        ts.factory.createPropertyAssignment(
            ts.factory.createStringLiteral(x),
            iterator(x, entries[x])
        )
    );

    return copyWithAddedProperty(
        object,
        ts.factory.createPropertyAssignment(
            name,
            ts.factory.createObjectLiteralExpression(properties)
        )
    );
}

const visitor: ts.Visitor = node => {
    const component_decorator = ts.canHaveDecorators(node)
        ? ts.getDecorators(node)?.filter(x => getDecoratorName(x) === 'Component')[0]
        : undefined;

    if (!component_decorator)
        return node;

    const computed: ComputedProperties = {},
             watch: WatchProperties = {},
             hooks: HookProperties = {};

    let methods = ts.factory.createObjectLiteralExpression(),
          props = ts.factory.createObjectLiteralExpression();

    // Needs fix
    // First argument of the component decorator is vue's `data` object; copy the whole thing out to use.
    let data = copyIfObject(getDecoratorArgument(component_decorator, 0));
    data = copyWithAddedProperty(data, ts.factory.createPropertyAssignment('methods', methods));
    data = copyWithAddedProperty(data, ts.factory.createPropertyAssignment('props', props));

    // Needs fix - let?
    let dataObj = ts.factory.createObjectLiteralExpression();

    const return_statement = ts.factory.createBlock([ts.factory.createReturnStatement(dataObj)]);
    const unknown_method_return = ts.factory.createMethodDeclaration(
        undefined,  undefined,
        'data',     undefined,
        undefined,  [],
        undefined,  return_statement);

    data = copyWithAddedProperty(data, unknown_method_return);

    const cls = ('heritageClauses' in node && 'members' in node)
        ? node as ts.ClassDeclaration
        : undefined;

    if (!cls)
        throw new Error('Component found as Class but failed to have the required "heritageClauses" and "members" properties.');

    // Needs fix - assertion
    const base = cls.heritageClauses!.filter(x => x.token == ts.SyntaxKind.ExtendsKeyword)[0].types[0];

    for (const member of cls.members) {
        const member_modifiers = ts.canHaveModifiers(member)
            ? ts.getModifiers(member)
            : undefined;

        // Abstract members should never be processed
        // (also handles members with no modifiers)
        if (member_modifiers?.some(x => x.kind === ts.SyntaxKind.AbstractKeyword))
            continue;

        if (ts.isAccessor(member)) {
            // Needs fix - name assertion
            const entry = computed[member.name!.getText()] || (computed[member.name!.getText()] = {});

            entry[ ts.isGetAccessor(member) ? 'get' : 'set' ] = member;
        }
        else if (ts.isPropertyDeclaration(member)) {
            const member_decorators = ts.canHaveDecorators(member)
                ? ts.getDecorators(member)
                : undefined;

            // If we have a prop decorator, use it. Otherwise continue as normal.
            const prop = member_decorators?.filter(x => getDecoratorName(x) === 'Prop')[0];
            if (prop) {
                const propData = copyIfObject(getDecoratorArgument(prop, 0));

                // Needs fix
                copyWithAddedProperty(props, ts.factory.createPropertyAssignment(member.name, propData));
            }
            // Interesting that we process props before $ tagged functions
            else if (member.name.getText().charAt(0) === '$') {
                continue; // "Do nothing"
            }
            else {
                const property_assignment = ts.factory.createPropertyAssignment(
                    member.name,
                    // Needs fix - assertion of prop declaration
                    (<ts.PropertyDeclaration>member).initializer || ts.factory.createIdentifier('undefined')
                );

                // Needs fix - returns new node
                dataObj = copyWithAddedProperty(dataObj, property_assignment);
            }
        }
        else if (ts.isMethodDeclaration(member)) {
            ts.forEachChild(member, node => replaceIfSuper(node, base));

            // Needs fix - returns new node
            methods = copyWithAddedProperty(methods, member);

            const hookDecorators = ts.canHaveDecorators(member)
                ? ts.getDecorators(member)?.filter(x => getDecoratorName(x) === 'Hook')
                : undefined;

            if (hookDecorators) {
                for (const hook of hookDecorators) {
                    // Ex: `@Hook('nameArg')`
                    const nameArg = getDecoratorArgument(hook, 0);
                    if (!nameArg || !ts.isStringLiteral(nameArg) || !nameArg.text)
                        throw new Error(`Malformed Hook decorator name: ${nameArg || 'Empty String'}`);

                    const entry = hooks[nameArg.text] || (hooks[nameArg.text] = []);

                    let member_name: ts.Expression;

                    if (ts.isLiteralExpression(member.name))
                        member_name = member.name;
                    else if (ts.isIdentifier(member.name))
                        member_name = ts.factory.createStringLiteralFromNode(member.name)
                    else if (ts.isComputedPropertyName(member.name))
                        member_name = member.name.expression;
                    else // if (ts.isPrivateIdentifier(member.name))
                        member_name = member.name;

                    entry.push(member_name);
                }
            }

            const watches = ts.canHaveDecorators(member)
                ? ts.getDecorators(member)?.filter(x => getDecoratorName(x) === 'Watch')
                : undefined;

            if (watches) {
                for (const watchDecorator of watches) {
                    const watch_data = copyIfObject(getDecoratorArgument(watchDecorator, 1));

                    const watch_property = ts.factory.createPropertyAssignment(
                        ts.factory.createIdentifier('handler'),
                        ts.factory.createStringLiteral(member.name.getText())
                    );

                    // Needs fix - returns new node
                    copyWithAddedProperty(watch_data, watch_property);

                    // Ex: `@Watch('nameArg')`
                    const nameArg = getDecoratorArgument(watchDecorator, 0);
                    if (!nameArg || !ts.isStringLiteral(nameArg) || !nameArg.text)
                        throw new Error(`Malformed Hook decorator name: ${nameArg || 'Empty String'}`);

                    const entry = hooks[nameArg.text] || (hooks[nameArg.text] = []);

                    entry.push(watch_data);
                }
            }

            // When we handle all the decorators, we destroy them.
            // Needs fix - if we create a new object that just doesn't have decorators in the ModifierLikes, that's destruction.
            const member_decorators = ts.canHaveDecorators(member)
                ? ts.getDecorators(member)
                : undefined;

            if (member_decorators) {
                // Needs fix - returns new node
                ts.factory.updateMethodDeclaration(
                    member,
                    ts.getModifiers(member), // Skip inclusion of decorators and we gucci
                    member.asteriskToken,
                    member.name,
                    member.questionToken,
                    member.typeParameters,
                    member.parameters,
                    member.type,
                    member.body
                )
            }
        }
    }

    // Needs fix - returns new node
    addEntriesAsProperties(data, computed, 'computed', handleComputedProperty);

    // Needs fix - returns new node
    addEntriesAsProperties(data, watch, 'watch', (_, value) =>
        ts.factory.createArrayLiteralExpression(value)
    );

    // At this point, `hooks` is a good list of our hook members
    for (const hook in hooks) {
        const block = hooks[hook].map(x => {
            const property_access = ts.factory.createPropertyAccessExpression(
                ts.factory.createElementAccessExpression(ts.factory.createThis(), x),
                'apply'
            );

            const args = [
                ts.factory.createThis(),
                ts.factory.createIdentifier('arguments'),
            ];

            return ts.factory.createExpressionStatement(
                ts.factory.createCallExpression(property_access, undefined, args)
            );
        });

        const hook_func = ts.factory.createMethodDeclaration(undefined, undefined, hook, undefined, undefined, [], undefined, ts.factory.createBlock(block));

        // Needs fix - returns new node
        copyWithAddedProperty(data, hook_func);
    }

    // Return trash
    const initializer = ts.factory.createCallExpression(
        ts.factory.createPropertyAccessExpression(
            base.expression,
            ts.factory.createIdentifier('extend')
        ),
        undefined,
        [ data ]
    );

    const class_variable = ts.factory.createVariableDeclaration(
        // Needs fix - name assertion
        cls.name!,
        undefined,
        undefined,
        initializer
    );

    return [
        ts.factory.createVariableStatement(
            [ ts.factory.createModifier(ts.SyntaxKind.ConstKeyword) ],
            [ class_variable ]
        ),
        // Needs fix - name assertion
        ts.factory.createExportDefault(cls.name!)
    ];
};

const transformer: ts.TransformerFactory<ts.SourceFile> = context => {
    return node => ts.visitEachChild(node, visitor, context);
};

export default transformer;
