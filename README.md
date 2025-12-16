# @frolic/vue-ts
This is a little helper library for precompiling Vue class components using a TypeScript transformer.

It is mostly intended for internal usage, and will not necessarily respect SemVer.

## Usage
`import '@frolic/vue-ts'` exposes the following decorators:
 - `@Component` for classes, accepting an optional `Vue.ComponentOptions` object. Do not use `computed`, `props`, `methods`, `watch`, `data`, or any lifecycle hooks here.
 - `@Prop` for properties, accepting an optional `Vue.PropOptions` object - these will be added to the `props` specification.
 - `@Watch` for methods, accepting a watch expression string and an optional `Vue.WatchOptions` object - these will be added to the `watch` specification.
 - `@Hook` for methods, accepting the name of a lifecycle function. These will be called in the respective lifecycle hooks.

In any class marked with `@Component`:
 - Property declarations not marked with `@Prop` will be added to `data`. Properties without an initializer will be initialized to `undefined`.
 - Method declarations not marked with `@Hook` will be added to `methods`.
 - Get and set accessor declarations will be added to `computed`. The existence of a set accessor without a corresponding get accessor is treated as an error.

The TypeScript transformer can be imported using `const vueTransformer = require('@f-list/vue-ts/transform').default;`.

It can then be added to ts-loader using the `getCustomTransformers: () => ({before: [vueTransformer]})` option.

## Important Notes
For any decorator parameters, make sure to only use literals rather than references.
While technically syntactically correct and not detected as an error by TypeScript, the transformer is not able to resolve such references, and the resulting behaviour is undefined.

The `super` keyword is only allowed for base method references. The occurrence outside of the expression of a call is treated as an error.
