import * as ts from 'typescript';

/**
 * TYPES
 */
type ComputedProperty = {
    get?: ts.AccessorDeclaration;
    set?: ts.AccessorDeclaration;
};

type ComputedProperties = {
    [key: string]: ComputedProperty,
};

type WatchProperties = {
    [key: string]: ts.ObjectLiteralExpression[];
};

type HookProperties = {
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

// function replaceIfSuper(
//     node: ts.Node,
//     base: ts.ExpressionWithTypeArguments
// ): void {}

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
    return undefined;
};

const transformer: ts.TransformerFactory<ts.SourceFile> = context => {
    return node => ts.visitEachChild(node, visitor, context);
};

export default transformer;
