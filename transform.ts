import * as ts from "typescript";

/**
 * TS4 Vue class decorator -> options transformer
 * No more node mutation allowed (remove decorators instead); use ts.factory to avoid most ts.create* deprecations; various guards
 */

/**
 * Effectively just runs `getText` on the decorator.
 */
function getDecoratorName(decorator: ts.Decorator): string | undefined {
    const expr = decorator.expression;

    if (ts.isCallExpression(expr))
        return expr.expression.getText(decorator.getSourceFile());

    return expr.getText(decorator.getSourceFile());
}

function getDecoratorArgument(decorator: ts.Decorator, index: number): ts.Expression | undefined {
    const expr = decorator.expression;

    return ts.isCallExpression(expr)
        ? expr.arguments[index]
        : undefined;
}

function isStringLiteralLike(node?: ts.Node): node is ts.StringLiteral {
    return !!node && ts.isStringLiteral(node);
}

/**
 * Return a new object literal expression which is old.properties + provided extras
 * @param factory
 * @param obj Objec to copy properties from
 * @param prop new properties to add to the object
 * @returns
 */
function appendObjectLiteralProperty(factory: ts.NodeFactory, obj: ts.ObjectLiteralExpression, prop: ts.ObjectLiteralElementLike) {
    return factory.createObjectLiteralExpression([ ...obj.properties, prop ], true);
}

/**
 * Return a shallow copy of an object literal (or an empty object)
 * @param factory
 * @param node
 * @returns
 */
function copyObjectLiteral(factory: ts.NodeFactory, node?: ts.Expression): ts.ObjectLiteralExpression {
    if (node && ts.isObjectLiteralExpression(node))
        return factory.createObjectLiteralExpression([ ...node.properties ], true);
    else
        return factory.createObjectLiteralExpression([], false);
}

/**
 * Getter for text of a name with extreme case handling and sanitization
 * @param name
 * @returns
 */
function nameToString(name?: ts.PropertyName): string {
    if (!name)
        return "";
    if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name))
        return name.text;
    if (ts.isStringLiteral(name) || ts.isNumericLiteral(name))
        return name.text;
    if (ts.isComputedPropertyName(name))
        return name.expression.getText();
    // @ts-ignore
    return name.getText();
}

const transformer: ts.TransformerFactory<ts.SourceFile> = (context) => {
    const factory = context.factory;

    const visitor: ts.Visitor = (node) => {
        const decs = ts.canHaveDecorators(node) ? ts.getDecorators(node) : undefined;
        if (!ts.isClassDeclaration(node) || !decs)
            return ts.visitEachChild(node, visitor, context);

        // region @Component
        const componentDec = decs.find(d => getDecoratorName(d) === "Component");
        if (!componentDec)
            return ts.visitEachChild(node, visitor, context);

        // optionsObj is the final frontier
        const componentArg = getDecoratorArgument(componentDec, 0);
        let optionsObj = copyObjectLiteral(factory, componentArg);

        const computed: Record<string, { get?: ts.GetAccessorDeclaration; set?: ts.SetAccessorDeclaration }> = {};
        const watch:    Record<string, ts.ObjectLiteralExpression[]> = {};
        const hooks:    Record<string, ts.Expression[]> = {};
        const methods:  ts.MethodDeclaration[]  = [];
        const props:    ts.PropertyAssignment[] = [];
        let dataProps:  ts.PropertyAssignment[] = [];

        // Only transform `extends Vue`
        const extendClause = node.heritageClauses?.find(h => h.token === ts.SyntaxKind.ExtendsKeyword);
        if (!extendClause?.types.length)
            return ts.visitEachChild(node, visitor, context);

        const baseType = extendClause.types[0];
        const baseExpr = baseType.expression; // Vue? Should be vue. Is vue.

        for (const member of node.members) {
            if (member.modifiers?.some(m => m.kind === ts.SyntaxKind.AbstractKeyword))
                continue;

            // region Computed
            if (ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) {
                const key = nameToString(member.name);
                const entry = computed[key] ?? (computed[key] = {});

                if (ts.isGetAccessorDeclaration(member))
                    entry.get = member;
                else
                    entry.set = member;

                continue;
            }

            // property -> props or data property
            if (ts.isPropertyDeclaration(member)) {
                const decs = ts.canHaveDecorators(member) ? ts.getDecorators(member) : undefined;

                // region @Prop Decs
                const propDec = decs?.find(d => getDecoratorName(d) === "Prop");

                if (propDec) {
                    const arg = getDecoratorArgument(propDec, 0);
                    const propOptions = copyObjectLiteral(factory, arg);
                    props.push(factory.createPropertyAssignment(member.name, propOptions));
                }
                else {
                    const nm = nameToString(member.name);
                    if (nm.startsWith("$"))
                        continue; // skip $ prefixed internals

                    const init = member.initializer ?? factory.createIdentifier("undefined");
                    dataProps.push(factory.createPropertyAssignment(member.name, init));
                }

                continue;
            }

            if (ts.isMethodDeclaration(member)) {
                function replaceSuperCalls(n: ts.Node): ts.Node {
                    if (ts.isCallExpression(n) && (ts.isPropertyAccessExpression(n.expression) || ts.isElementAccessExpression(n.expression)) && n.expression.expression.kind === ts.SyntaxKind.SuperKeyword) {
                        // build access to base.options.methods.someName or base.options.methods[someExpr]
                        const methodsAccess = factory.createPropertyAccessExpression(
                            factory.createPropertyAccessExpression(baseExpr, factory.createIdentifier("options")),
                            factory.createIdentifier("methods")
                        );

                        let methodAccessExpr: ts.Expression;
                        if (ts.isPropertyAccessExpression(n.expression))
                            methodAccessExpr = factory.createPropertyAccessExpression(methodsAccess, n.expression.name);
                        else
                            methodAccessExpr = factory.createElementAccessExpression(methodsAccess, n.expression.argumentExpression);

                        const callMember = factory.createPropertyAccessExpression(methodAccessExpr, factory.createIdentifier("call"));
                        return factory.createCallExpression(callMember, n.typeArguments, [factory.createThis(), ...n.arguments]);
                    }

                    return ts.visitEachChild(n, replaceSuperCalls, context);
                }

                const replacedMethod = ts.visitEachChild(member, replaceSuperCalls, context) as ts.MethodDeclaration;

                const mods = replacedMethod.modifiers?.filter(ts.isModifier);

                // rebuilt method without decorators
                const methodNoDecorators = factory.updateMethodDeclaration(
                    replacedMethod,
                    /*decorators*/ undefined,
                    mods,
                    replacedMethod.asteriskToken,
                    replacedMethod.name,
                    replacedMethod.questionToken,
                    replacedMethod.typeParameters,
                    replacedMethod.parameters,
                    replacedMethod.type,
                    replacedMethod.body
                );

                methods.push(methodNoDecorators);

                const decs = ts.canHaveDecorators(member) ? ts.getDecorators(member) : undefined;

                // region @Hook Decs
                const hookDecs = decs?.filter(d => getDecoratorName(d) === "Hook") ?? [];

                for (const dec of hookDecs) {
                    const nameArg = getDecoratorArgument(dec, 0);
                    const hookName = isStringLiteralLike(nameArg) ? nameArg.text : nameToString(member.name);

                    // store a representation we can invoke later (string or expression)
                    if (ts.isIdentifier(member.name) || ts.isPrivateIdentifier(member.name) || ts.isStringLiteral(member.name) || ts.isNumericLiteral(member.name)) {
                        hooks[hookName] = hooks[hookName] ?? [];
                        hooks[hookName].push(factory.createStringLiteral(nameToString(member.name)));
                    }
                    else if (ts.isComputedPropertyName(member.name)) {
                        hooks[hookName] = hooks[hookName] ?? [];
                        hooks[hookName].push(member.name.expression);
                    }
                    else {
                        hooks[hookName] = hooks[hookName] ?? [];
                        hooks[hookName].push(factory.createStringLiteral(nameToString(member.name)));
                    }
                }

                // region @Watch Decs
                const watchDecs = decs?.filter(d => getDecoratorName(d) === "Watch") ?? [];

                for (const dec of watchDecs) {
                    const watchedArg = getDecoratorArgument(dec, 0);
                    const optsArg = getDecoratorArgument(dec, 1);
                    const existing = copyObjectLiteral(factory, optsArg);
                    // add handler property referencing the method name
                    const handlerAssign = factory.createPropertyAssignment(factory.createIdentifier("handler"), factory.createStringLiteral(nameToString(member.name)));
                    const merged = appendObjectLiteralProperty(factory, existing, handlerAssign);
                    const key = isStringLiteralLike(watchedArg) ? watchedArg.text : nameToString(watchedArg as ts.PropertyName);
                    (watch[key] ??= []).push(merged);
                }

                continue;
            }
        }

        // region Methods/Props
        const existingMethodsProp = optionsObj.properties.find(p => ts.isPropertyAssignment(p) && p.name && nameToString((p.name as ts.Identifier)) === "methods") as ts.PropertyAssignment | undefined;
        const existingPropsProp = optionsObj.properties.find(p => ts.isPropertyAssignment(p) && p.name && nameToString((p.name as ts.Identifier)) === "props") as ts.PropertyAssignment | undefined;

        let methodsObj = existingMethodsProp && ts.isObjectLiteralExpression(existingMethodsProp.initializer)
            ? existingMethodsProp.initializer
            : factory.createObjectLiteralExpression([], true);

        let propsObj = existingPropsProp && ts.isObjectLiteralExpression(existingPropsProp.initializer)
            ? existingPropsProp.initializer
            : factory.createObjectLiteralExpression([], true);

        if (methods.length) {
            const methodElements: ts.ObjectLiteralElementLike[] = methods.map(m => {
                const nameNode = ts.isIdentifier(m.name) || ts.isStringLiteral(m.name) || ts.isNumericLiteral(m.name) || ts.isComputedPropertyName(m.name)
                    ? m.name
                    : factory.createIdentifier(nameToString(m.name));

                const mods = m.modifiers?.filter(ts.isModifier);

                return factory.createMethodDeclaration(
                    /*decorators*/ undefined,
                    mods,
                    m.asteriskToken,
                    nameNode,
                    m.questionToken,
                    m.typeParameters,
                    m.parameters,
                    m.type,
                    m.body
                );
            });

            methodsObj = factory.createObjectLiteralExpression([...methodsObj.properties, ...methodElements], true);
        }

        if (props.length)
            propsObj = factory.createObjectLiteralExpression([...propsObj.properties, ...props], true);

        // replace (or add) methods and props in optionsObj
        // remove old methods/props if they exist and rebuild options property list
        const filteredProps = optionsObj.properties
            .filter(p => {
                if (!ts.isPropertyAssignment(p))
                    return true;

                const n = nameToString(p.name);
                return n !== "methods" && n !== "props" && n !== "data";
            });

        optionsObj = factory.createObjectLiteralExpression([
                ...filteredProps,
                factory.createPropertyAssignment("methods", methodsObj),
                factory.createPropertyAssignment("props", propsObj),
            ],
            true
        );

        // data method
        if (dataProps.length) {
            const dataFn = factory.createMethodDeclaration(
                undefined,
                undefined,
                undefined,
                "data",
                undefined,
                undefined,
                [],
                undefined,
                factory.createBlock([factory.createReturnStatement(factory.createObjectLiteralExpression(dataProps, true))], true)
            );

            // append data method (replace if exists)
            const withoutData = optionsObj.properties.filter(p => !(ts.isPropertyAssignment(p) && nameToString(p.name) === "data"));
            optionsObj = factory.createObjectLiteralExpression([...withoutData, dataFn], true);
        }

        // region Computed
        const computedKeys = Object.keys(computed);
        if (computedKeys.length) {
            const computedProps: ts.PropertyAssignment[] = computedKeys.map(key => {
                const entry = computed[key];
                if (!entry.get)
                    throw new Error("No getter defined for " + key);

                const elProps: ts.ObjectLiteralElementLike[] = [
                    factory.createMethodDeclaration(undefined, undefined, undefined, "get", undefined, undefined, [], undefined, entry.get.body!),
                ];

                if (entry.set)
                    elProps.push(
                        factory.createMethodDeclaration(undefined, undefined, undefined, "set", undefined, undefined, entry.set.parameters, undefined, entry.set.body!)
                    );

                return factory.createPropertyAssignment(
                    factory.createStringLiteral(key),
                    factory.createObjectLiteralExpression(elProps, true)
                );
            });

            optionsObj = appendObjectLiteralProperty(factory, optionsObj, factory.createPropertyAssignment("computed", factory.createObjectLiteralExpression(computedProps, true)));
        }

        // region @Watch
        const watchKeys = Object.keys(watch);
        if (watchKeys.length) {
            const watchProps = watchKeys.map(k => factory.createPropertyAssignment(factory.createStringLiteral(k), factory.createArrayLiteralExpression(watch[k], true)));

            optionsObj = appendObjectLiteralProperty(factory, optionsObj, factory.createPropertyAssignment("watch", factory.createObjectLiteralExpression(watchProps, true)));
        }

        // region @Hook
        // convert hooks -> methods as God intended
        for (const hookName of Object.keys(hooks)) {
            const stmts = hooks[hookName].map(expr => {
                let elementAccess: ts.Expression;

                if (ts.isStringLiteral(expr) || ts.isNumericLiteral(expr))
                    elementAccess = factory.createElementAccessExpression(factory.createThis(), expr);
                else
                    elementAccess = factory.createElementAccessExpression(factory.createThis(), expr);

                return factory.createExpressionStatement(
                    factory.createCallExpression(
                        factory.createPropertyAccessExpression(elementAccess, "apply"),
                        undefined,
                        [ factory.createThis(), factory.createIdentifier("arguments") ]
                    )
                );
            });

            const hookMethod = factory.createMethodDeclaration(undefined, undefined, undefined, hookName, undefined, undefined, [], undefined, factory.createBlock(stmts, true));

            optionsObj = appendObjectLiteralProperty(factory, optionsObj, hookMethod);
        }

        // optionsObj is complete. The world is saved.
        // now build: const <ClassName> = <baseExpr>.extend(optionsObj);

        if (!node.name) // catch no var name - ts says we can hit this
            return ts.visitEachChild(node, visitor, context);

        const classId = node.name;

        const extendCall = factory.createCallExpression(
            factory.createPropertyAccessExpression(baseExpr as ts.Expression, factory.createIdentifier("extend")),
            undefined,
            [ optionsObj ]
        );

        const varDecl = factory.createVariableStatement(
            [ factory.createModifier(ts.SyntaxKind.ConstKeyword) ],
            factory.createVariableDeclarationList(
                [ factory.createVariableDeclaration(classId, undefined, undefined, extendCall) ],
                ts.NodeFlags.Const
            )
        );

        const isExport  = node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword);
        const isDefault = node.modifiers?.some(m => m.kind === ts.SyntaxKind.DefaultKeyword);

        if (isExport && isDefault) {
            return [ varDecl, factory.createExportDefault(classId) ];
        }
        else if (isExport && !isDefault) {
            const spec = factory.createExportSpecifier(false, undefined, classId);
            const namedExport = factory.createExportDeclaration(undefined, undefined, false, factory.createNamedExports([ spec ]), undefined);

            return [ varDecl, namedExport ];
        }
        else {
            return varDecl;
        }
    };

    return (file) => ts.visitNode(file, function walk(n) {
        return ts.visitEachChild(n, visitor, context);
    });
};

export default transformer;
