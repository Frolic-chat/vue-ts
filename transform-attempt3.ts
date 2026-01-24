import * as ts from 'typescript';

/**
 * TYPES
 */
type ComputedProperties = {
    [key: string]: {
        get?: ts.AccessorDeclaration;
        set?: ts.AccessorDeclaration;
    },
};

type WatchProperties = {
    [key: string]: ts.ObjectLiteralExpression[];
};

type HookProperties = {
    [key: string]: ts.Expression[];
};

function getDecoratorName(
    decorator: ts.Decorator
): string
{
    return ts.isCallExpression(decorator.expression) ? decorator.expression.expression.getText(decorator.getSourceFile()) : decorator.expression.getText(decorator.getSourceFile());
}

function getDecoratorArgument(
    decorator: ts.Decorator,
    index: number
): ts.Expression | undefined
{
    return ts.isCallExpression(decorator.expression) ? decorator.expression.arguments[index] : undefined;
}

function createProperty(
    object: ts.ObjectLiteralExpression,
    expr: ts.ObjectLiteralElementLike,
): ts.ObjectLiteralExpression
{
    // Old:
    // (<ts.ObjectLiteralElementLike[]><unknown>object.properties).push(expr);

    const new_props = ts.factory.createNodeArray([...object.properties, expr]);

    return ts.factory.updateObjectLiteralExpression(object, new_props);
}

// function createProperty_old(object: ts.ObjectLiteralExpression, expr: ts.ObjectLiteralElementLike) {
//     (<ts.ObjectLiteralElementLike[]><unknown>object.properties).push(expr);
// }

function copyIfObject(
    object: ts.Node | undefined
): ts.ObjectLiteralExpression
{
    return ts.factory.createObjectLiteralExpression(object && ts.isObjectLiteralExpression(object) ? object.properties : undefined);
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

        node.expression = ts.factory.createPropertyAccessExpression(ts.factory.createPropertyAccessExpression(base.expression, 'options'), 'methods');

        node.parent.expression = ts.factory.createPropertyAccessExpression(node, 'call');

        (<ts.Expression[]><unknown>node.parent.arguments).unshift(ts.factory.createThis());
    }
    else {
        ts.forEachChild(node, node => replaceIfSuper(node, base));
    }
}

function createIfAny<T>(
    object: ts.ObjectLiteralExpression,
    entries: { [key: string]: T },
    name: string,
    iterator: (key: string, value: T) => ts.Expression
): void
{
    const keys = Object.keys(entries);
    if (!keys.length)
        return;

    const properties = keys.map(x =>
        ts.factory.createPropertyAssignment(
            ts.factory.createStringLiteral(x),
            iterator(x, entries[x])
        )
    );

    // Needs fix
    createProperty(
        object,
        ts.factory.createPropertyAssignment(
            name,
            ts.factory.createObjectLiteralExpression(properties)
        )
    );
}

const visitor: ts.Visitor = node => {
    const decorator = ts.canHaveDecorators(node)
        ? ts.getDecorators(node)?.filter(x => getDecoratorName(x) === 'Component')[0]
        : undefined;

    if (decorator) {
        const computed: ComputedProperties = {},
              watch: WatchProperties = {},
              hooks: HookProperties = {};

        const methods = ts.factory.createObjectLiteralExpression(),
              props = ts.factory.createObjectLiteralExpression();

        const data = copyIfObject(getDecoratorArgument(decorator, 0));

        // Needs fix
        createProperty(data, ts.factory.createPropertyAssignment('methods', methods));
        // Needs fix
        createProperty(data, ts.factory.createPropertyAssignment('props', props));

        // Needs fix - let?
        const dataObj = ts.factory.createObjectLiteralExpression();

        const return_statement = ts.factory.createBlock([ts.factory.createReturnStatement(dataObj)]);
        const unknown_method_return = ts.factory.createMethodDeclaration(
            undefined,  undefined,
            'data',     undefined,
            undefined,  [],
            undefined,  return_statement);

        // Needs fix
        createProperty(data, unknown_method_return);

        // Needs fix
        const cls = <ts.ClassDeclaration>node;

        // Needs fix
        const base = cls.heritageClauses!.filter(x => x.token == ts.SyntaxKind.ExtendsKeyword)[0].types[0];

        for (const member of cls.members) {
            const member_modifiers = ts.canHaveModifiers(member)
                ? ts.getModifiers(member)
                : undefined;

            if (member_modifiers?.some(x => x.kind === ts.SyntaxKind.AbstractKeyword))
                continue;

            if (ts.isAccessor(member)) {
                const entry = computed[member.name!.getText()] || (computed[member.name!.getText()] = {});

                entry[ ts.isGetAccessor(member) ? 'get' : 'set' ] = member;
            }
            else if (ts.isPropertyDeclaration(member)) {
                const member_decorators = ts.canHaveDecorators(member)
                    ? ts.getDecorators(member)
                    : undefined;

                const prop = member_decorators?.filter(x => getDecoratorName(x) === 'Prop')[0];

                if (prop) {
                    const propData = copyIfObject(getDecoratorArgument(prop, 0));

                    // Needs fix
                    createProperty(props, ts.factory.createPropertyAssignment(member.name, propData));

                    continue;
                }

                // Interesting that we process props before $ tagged functions
                if (member.name.getText().charAt(0) === '$')
                    continue;

                const property_assignment = ts.factory.createPropertyAssignment(
                    member.name,
                    (<ts.PropertyDeclaration>member).initializer || ts.factory.createIdentifier('undefined')
                );

                // Needs fix
                createProperty(dataObj, property_assignment);
            }
            else if (ts.isMethodDeclaration(member)) {
                ts.forEachChild(member, node => replaceIfSuper(node, base));

                // Needs fix
                createProperty(methods, member);

                const hookDecorators = ts.canHaveDecorators(member)
                    ? ts.getDecorators(member)?.filter(x => getDecoratorName(x) === 'Hook')
                    : undefined;

                if (hookDecorators) {
                    for (const hook of hookDecorators) {
                        // Needs fix
                        const name = (<ts.StringLiteral>getDecoratorArgument(hook, 0)).text;

                        const entry = hooks[name] || (hooks[name] = []);

                        const member_name = ts.isLiteralExpression(member.name)
                            ? member.name
                            : ts.isIdentifier(member.name)
                                ? ts.factory.createStringLiteralFromNode(member.name)
                                : member.name.expression;

                        entry.push(member_name);
                    }
                }

                const watches = ts.canHaveDecorators(member)
                    ? ts.getDecorators(member)?.filter(x => getDecoratorName(x) === 'Watch')
                    : undefined;

                if (watches) {
                    for (const watchDecorator of watches) {
                        const watchData = copyIfObject(getDecoratorArgument(watchDecorator, 1));

                        // Needs fix
                        createProperty(
                            watchData,
                            ts.factory.createPropertyAssignment(
                                ts.factory.createIdentifier('handler'),
                                ts.factory.createStringLiteral(member.name.getText())
                            )
                        );

                        const name = (<ts.StringLiteral>getDecoratorArgument(watchDecorator, 0)).text;

                        const entry = watch[name] || (watch[name] = []);

                        entry.push(watchData);
                    }
                }

                // When we handle all the decorators, we destroy them.
                const member_decorators = ts.canHaveDecorators(member)
                    ? ts.getDecorators(member)
                    : undefined;

                if (member_decorators) {
                    // Needs fix.
                    ts.factory.updateMethodDeclaration(
                        member,
                        ts.getModifiers(member),
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

        createIfAny(data, computed, 'computed', (key, value) => {
            if (!value.get)
                throw new Error("No getter defined for " + key);

            const prop = ts.factory.createObjectLiteralExpression(
                [
                    ts.factory.createMethodDeclaration(undefined, undefined, 'get', undefined, undefined, [], undefined, value.get.body)
                ]
            );

            if (value.set) {
                const vue_set_func = ts.factory.createMethodDeclaration(undefined, undefined, 'set', undefined, undefined, value.set.parameters, undefined, value.set.body);

                // Needs fix
                createProperty(prop, vue_set_func);
            }

            return prop;
        });

        createIfAny(data, watch, 'watch', (_, value) =>
            ts.factory.createArrayLiteralExpression(value)
        );

        for (const hook in hooks) {
            const block = hooks[hook].map(x =>
                ts.factory.createExpressionStatement(
                    ts.factory.createCallExpression(
                        ts.factory.createPropertyAccessExpression(
                            ts.factory.createElementAccessExpression(ts.factory.createThis(), x),
                            'apply'
                        ),
                        undefined,
                        [
                            ts.factory.createThis(),
                            ts.factory.createIdentifier('arguments'),
                        ],
                    )
                )
            );

            const hook_func = ts.factory.createMethodDeclaration(undefined, undefined, hook, undefined, undefined, [], undefined, ts.factory.createBlock(block));

            // Needs fix
            createProperty(data, hook_func);
        }

        // Return trash
        const class_variable = ts.factory.createVariableDeclaration(
                    cls.name!,
                    undefined,
                    undefined,
                    ts.factory.createCallExpression(
                        ts.factory.createPropertyAccessExpression(
                            base.expression,
                            ts.factory.createIdentifier('extend')
                        ),
                        undefined,
                        [ data ]
                    )
                );

        return [
            ts.factory.createVariableStatement(
                [ ts.factory.createModifier(ts.SyntaxKind.ConstKeyword) ],
                [ class_variable ]
            ),
            ts.factory.createExportDefault(cls.name!)
        ];
    }
    return node
};

const transformer: ts.TransformerFactory<ts.SourceFile> = context => {
    return node => ts.visitEachChild(node, visitor, context);
};

export default transformer;
