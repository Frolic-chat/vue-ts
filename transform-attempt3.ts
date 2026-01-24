import * as ts from 'typescript';

function getDecoratorName(decorator: ts.Decorator) {
    return ts.isCallExpression(decorator.expression) ? decorator.expression.expression.getText(decorator.getSourceFile()) : decorator.expression.getText(decorator.getSourceFile());
}

function getDecoratorArgument(decorator: ts.Decorator, index: number) {
    return ts.isCallExpression(decorator.expression) ? decorator.expression.arguments[index] : undefined;
}

function createProperty(
    object: ts.ObjectLiteralExpression,
    expr: ts.ObjectLiteralElementLike,
): void
{
    // Old:
    // (<ts.ObjectLiteralElementLike[]><unknown>object.properties).push(expr);

    const new_props = ts.factory.createNodeArray([ ...object.properties, expr ]);

    ts.factory.updateObjectLiteralExpression(object, new_props);
}

function createProperty_old(object: ts.ObjectLiteralExpression, expr: ts.ObjectLiteralElementLike) {
    (<ts.ObjectLiteralElementLike[]><unknown>object.properties).push(expr);
}

function copyIfObject(object: ts.Node | undefined) {
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
    if((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && node.expression.kind === ts.SyntaxKind.SuperKeyword) {
        if(!ts.isCallExpression(node.parent))
            throw new Error('The super keyword is only supported in call expressions.');
        node.expression = ts.factory.createPropertyAccessExpression(ts.factory.createPropertyAccessExpression(base.expression, 'options'), 'methods');
        node.parent.expression = ts.factory.createPropertyAccessExpression(node, 'call');
        (<ts.Expression[]><unknown>node.parent.arguments).unshift(ts.factory.createThis());
    } else ts.forEachChild(node, node => replaceIfSuper(node, base));
}

function createIfAny<T>(
    object: ts.ObjectLiteralExpression,
    entries: {[key: string]: T},
    name: string,
    iterator: (key: string, value: T) => ts.Expression
): void
{
    const keys = Object.keys(entries);
    if(!keys.length) return;
    createProperty(object, ts.factory.createPropertyAssignment(name, ts.factory.createObjectLiteralExpression(keys.map(x => ts.factory.createPropertyAssignment(ts.factory.createStringLiteral(x), iterator(x, entries[x]))))));
}

const transformer: ts.TransformerFactory<ts.SourceFile> = (context) => {
    const visitor: ts.Visitor = (node) => {
        const decorator = ts.canHaveDecorators(node) && ts.getDecorators(node)?.filter(x => getDecoratorName(x) === 'Component')[0];
        if(decorator) {
            const data = copyIfObject(getDecoratorArgument(decorator, 0));
            const computed: {[key: string]: {get?: ts.AccessorDeclaration, set?: ts.AccessorDeclaration}} = {}, watch: {[key: string]: ts.ObjectLiteralExpression[]} = {}, hooks: {[key: string]: ts.Expression[]} = {};
            const methods = ts.factory.createObjectLiteralExpression(), props = ts.factory.createObjectLiteralExpression();
            createProperty(data, ts.factory.createPropertyAssignment('methods', methods));
            createProperty(data, ts.factory.createPropertyAssignment('props', props));
            const dataObj = ts.factory.createObjectLiteralExpression();
            createProperty(data, ts.factory.createMethodDeclaration(undefined, undefined, 'data', undefined, undefined, [], undefined, ts.factory.createBlock([ts.factory.createReturnStatement(dataObj)])));
            const cls = <ts.ClassDeclaration>node;
            const base = cls.heritageClauses!.filter(x => x.token == ts.SyntaxKind.ExtendsKeyword)[0].types[0];
            for(const member of cls.members) {
                // Seemingly, the right solution is just to not do pointless work. Who would have thought?
                // Come back to this at some point and see if we can early return.
                // if(!member.decorators) member.decorators = ts.factory.createNodeArray();
                const member_modifiers = ts.canHaveModifiers(member) ? ts.getModifiers(member) : undefined;
                if(member_modifiers?.some(x => x.kind === ts.SyntaxKind.AbstractKeyword)) continue;
                if(ts.isAccessor(member)) {
                    const entry = computed[member.name!.getText()] || (computed[member.name!.getText()] = {});
                    entry[ts.isGetAccessor(member) ? 'get' : 'set'] = member;
                } else if(ts.isPropertyDeclaration(member)) {
                    const member_decorators = ts.canHaveDecorators(member) ? ts.getDecorators(member) : undefined;
                    const prop = member_decorators?.filter(x => getDecoratorName(x) === 'Prop')[0];
                    if(prop) {
                        const propData = copyIfObject(getDecoratorArgument(prop, 0));
                        //if(property.type)
                        //    createProperty(propData, ts.createPropertyAssignment('type', ts.createIdentifier(property.type.getText())));
                        createProperty(props, ts.factory.createPropertyAssignment(member.name, propData));
                        continue;
                    }
                    if(member.name.getText().charAt(0) === '$') continue;
                    createProperty(dataObj, ts.factory.createPropertyAssignment(member.name, (<ts.PropertyDeclaration>member).initializer || ts.factory.createIdentifier('undefined')))
                } else if(ts.isMethodDeclaration(member)) {
                    ts.forEachChild(member, node => replaceIfSuper(node, base));
                    createProperty(methods, member);
                    const hookDecorators = ts.canHaveDecorators(member) ? ts.getDecorators(member)?.filter(x => getDecoratorName(x) === 'Hook') : undefined;
                    if (hookDecorators) {
                        for(const hook of hookDecorators) {
                            const name = (<ts.StringLiteral>getDecoratorArgument(hook, 0)).text;
                            const entry = hooks[name] || (hooks[name] = []);
                            entry.push(ts.isLiteralExpression(member.name) ? member.name : ts.isIdentifier(member.name) ? ts.factory.createStringLiteralFromNode(member.name) : member.name.expression);
                        }
                    }
                    const watches = ts.canHaveDecorators(member) ? ts.getDecorators(member)?.filter(x => getDecoratorName(x) === 'Watch') : undefined;
                    if (watches) {
                        for(const watchDecorator of watches) {
                            const watchData = copyIfObject(getDecoratorArgument(watchDecorator, 1));
                            createProperty(watchData, ts.factory.createPropertyAssignment(ts.factory.createIdentifier('handler'), ts.factory.createStringLiteral(member.name.getText())))
                            const name = (<ts.StringLiteral>getDecoratorArgument(watchDecorator, 0)).text;
                            const entry = watch[name] || (watch[name] = []);
                            entry.push(watchData);
                        }
                    }

                    // When we handle all the decorators, we destroy them.
                    const member_decorators = ts.canHaveDecorators(member) ? ts.getDecorators(member) : undefined;
                    if (member_decorators) {
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
                if(!value.get) throw new Error("No getter defined for " + key);
                const prop = ts.factory.createObjectLiteralExpression([ts.factory.createMethodDeclaration(undefined, undefined, 'get', undefined, undefined, [], undefined, value.get.body)]);
                if(value.set)
                    createProperty(prop, ts.factory.createMethodDeclaration(undefined, undefined, 'set', undefined, undefined, value.set.parameters, undefined, value.set.body))
                return prop;
            })
            createIfAny(data, watch, 'watch', (_, value) => ts.factory.createArrayLiteralExpression(value));
            for(const hook in hooks) {
                const block = hooks[hook].map(x => ts.factory.createExpressionStatement(ts.factory.createCallExpression(ts.factory.createPropertyAccessExpression(ts.factory.createElementAccessExpression(ts.factory.createThis(), x), 'apply'), undefined, [ts.factory.createThis(), ts.factory.createIdentifier('arguments')])))
                createProperty(data, ts.factory.createMethodDeclaration(undefined, undefined, hook, undefined, undefined, [], undefined, ts.factory.createBlock(block)));
            }

            return [
                ts.factory.createVariableStatement([ts.factory.createModifier(ts.SyntaxKind.ConstKeyword)],
                    [ts.factory.createVariableDeclaration(cls.name!, undefined, undefined, ts.factory.createCallExpression(ts.factory.createPropertyAccessExpression(base.expression, ts.factory.createIdentifier('extend')), undefined, [data]))]),
                ts.factory.createExportDefault(cls.name!)
            ];
        }
        return node
    };

    return (node) => ts.visitEachChild(node, visitor, context);
};

export default transformer;
