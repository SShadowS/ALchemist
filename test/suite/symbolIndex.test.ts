import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { ParseCache } from '../../src/symbols/parseCache';
import { SymbolIndex } from '../../src/symbols/symbolIndex';
import { WorkspaceModel } from '../../src/workspace/workspaceModel';

const WASM_DIR = path.resolve(__dirname, '../../../dist');
const FIX = path.resolve(__dirname, '../../../test/fixtures');

suite('SymbolIndex — initial scan + lookups', () => {
  let cache: ParseCache;
  suiteSetup(async () => {
    cache = new ParseCache(WASM_DIR);
    await cache.initialize();
  });
  suiteTeardown(() => cache.dispose());

  test('initialize populates declared symbols from multi-app fixture', async () => {
    const model = new WorkspaceModel([path.join(FIX, 'multi-app')]);
    await model.scan();
    const index = new SymbolIndex();
    await index.initialize(model, cache);
    assert.strictEqual(index.isReady(), true);
    const declarer = index.getDeclarer('ALchemist.Tests.MainAppTest.SomeTestCodeunit');
    assert.ok(declarer, 'expected declarer for SomeTestCodeunit');
    assert.ok(declarer!.endsWith('SomeTest.Codeunit.al'));
    index.dispose();
  });

  test('getReferencers returns empty set for unreferenced symbol', async () => {
    const model = new WorkspaceModel([path.join(FIX, 'multi-app')]);
    await model.scan();
    const index = new SymbolIndex();
    await index.initialize(model, cache);
    const refs = index.getReferencers('ALchemist.Tests.MainApp.NonExistent');
    assert.strictEqual(refs.size, 0);
    index.dispose();
  });

  test('FqName resolves via local namespace', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alch-idx-'));
    try {
      fs.mkdirSync(path.join(tmp, 'A', 'src'), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'A', 'app.json'), JSON.stringify({
        id: 'a', name: 'A', publisher: 'p', version: '1.0.0.0',
      }));
      fs.writeFileSync(path.join(tmp, 'A', 'src', 'Foo.al'), 'namespace App; codeunit 50000 Foo { }');
      fs.writeFileSync(path.join(tmp, 'A', 'src', 'Bar.al'), `
namespace App;
codeunit 50001 Bar {
  procedure Run() var x: Codeunit Foo; begin end;
}`);
      const model = new WorkspaceModel([tmp]);
      await model.scan();
      const index = new SymbolIndex();
      await index.initialize(model, cache);
      const refs = index.getReferencers('App.Foo');
      assert.strictEqual(refs.size, 1, 'expected one referrer (Bar.al) for App.Foo');
      index.dispose();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('FqName resolves via using clause', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alch-idx-'));
    try {
      fs.mkdirSync(path.join(tmp, 'A', 'src'), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'A', 'app.json'), JSON.stringify({
        id: 'a', name: 'A', publisher: 'p', version: '1.0.0.0',
      }));
      fs.writeFileSync(path.join(tmp, 'A', 'src', 'Foo.al'), 'namespace Lib.X; codeunit 50000 Foo { }');
      fs.writeFileSync(path.join(tmp, 'A', 'src', 'Bar.al'), `
namespace App;
using Lib.X;
codeunit 50001 Bar {
  procedure Run() var x: Codeunit Foo; begin end;
}`);
      const model = new WorkspaceModel([tmp]);
      await model.scan();
      const index = new SymbolIndex();
      await index.initialize(model, cache);
      const refs = index.getReferencers('Lib.X.Foo');
      assert.strictEqual(refs.size, 1);
      index.dispose();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('FqName resolves to global when no namespace and no using', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alch-idx-'));
    try {
      fs.mkdirSync(path.join(tmp, 'A', 'src'), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'A', 'app.json'), JSON.stringify({
        id: 'a', name: 'A', publisher: 'p', version: '1.0.0.0',
      }));
      fs.writeFileSync(path.join(tmp, 'A', 'src', 'Foo.al'), 'codeunit 50000 Foo { }');
      fs.writeFileSync(path.join(tmp, 'A', 'src', 'Bar.al'), `
codeunit 50001 Bar {
  procedure Run() var x: Codeunit Foo; begin end;
}`);
      const model = new WorkspaceModel([tmp]);
      await model.scan();
      const index = new SymbolIndex();
      await index.initialize(model, cache);
      const refs = index.getReferencers('Foo');
      assert.strictEqual(refs.size, 1);
      index.dispose();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('getTestsInFile returns tests declared in that file', async () => {
    const model = new WorkspaceModel([path.join(FIX, 'multi-app')]);
    await model.scan();
    const index = new SymbolIndex();
    await index.initialize(model, cache);
    const testFile = path.join(FIX, 'multi-app/MainApp.Test/src/SomeTest.Codeunit.al');
    const tests = index.getTestsInFile(testFile);
    assert.ok(tests.length >= 1);
    assert.ok(tests.some((t: { procName: string }) => t.procName === 'ComputeDoubles'));
    index.dispose();
  });

  test('getAllTests groups by app id', async () => {
    const model = new WorkspaceModel([path.join(FIX, 'multi-app')]);
    await model.scan();
    const index = new SymbolIndex();
    await index.initialize(model, cache);
    const all = index.getAllTests();
    const testApp = model.getApps().find(a => a.name === 'MainApp.Test')!;
    assert.ok(all.has(testApp.id));
    assert.ok((all.get(testApp.id)!).length >= 1);
    index.dispose();
  });
});
