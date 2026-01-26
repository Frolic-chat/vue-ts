// run-transform.ts
import * as ts from 'typescript';
import transformer from '../transform';

const fileName = 'test.ts';
const sourceText = ts.sys.readFile(fileName);
if (!sourceText) throw new Error(`Cannot read ${fileName}`);

// ----- 1️⃣ Simple, single‑file transpile
const transpile = ts.transpileModule(sourceText, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    jsx: ts.JsxEmit.Preserve,   // set whatever options you need
  },
  transformers: { before: [ transformer ] },
});

console.log('--- transpiled output ---');
console.log(transpile.outputText);

// ----- 2️⃣ Full program (useful when you have imports)
// ----------------------------------------------------------------
// Create a TypeScript program that knows all source files
const program = ts.createProgram([fileName], {
  module: ts.ModuleKind.CommonJS,
  jsx: ts.JsxEmit.Preserve,
  // …add any other needed compilerOptions here
});

const emitResult = program.emit(undefined, undefined, undefined, false, {
  before: [ transformer ],
});

const diagnostics = ts.getPreEmitDiagnostics(program).concat(emitResult.diagnostics);

diagnostics.forEach(d => {
  const { line, character } = ts.getLineAndCharacterOfPosition(d.file!, d.start!);
  const message = ts.flattenDiagnosticMessageText(d.messageText, '\n');
  console.log(`${d.file!.fileName} (${line + 1},${character + 1}): ${message}`);
});

if (emitResult.emitSkipped) {
  console.error('Emit skipped due to errors.');
}
