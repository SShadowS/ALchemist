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

suite('SymbolIndex — incremental + watcher', () => {
  let cache: ParseCache;
  suiteSetup(async () => {
    cache = new ParseCache(WASM_DIR);
    await cache.initialize();
  });
  suiteTeardown(() => cache.dispose());

  test('refreshFile updates referrers when a new ref is added', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alch-idx-'));
    try {
      fs.mkdirSync(path.join(tmp, 'A', 'src'), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'A', 'app.json'), JSON.stringify({
        id: 'a', name: 'A', publisher: 'p', version: '1.0.0.0',
      }));
      fs.writeFileSync(path.join(tmp, 'A', 'src', 'Foo.al'), 'codeunit 50000 Foo { }');
      const barPath = path.join(tmp, 'A', 'src', 'Bar.al');
      fs.writeFileSync(barPath, 'codeunit 50001 Bar { }');
      const model = new WorkspaceModel([tmp]);
      await model.scan();
      const index = new SymbolIndex();
      await index.initialize(model, cache);
      assert.strictEqual(index.getReferencers('Foo').size, 0);
      fs.writeFileSync(barPath, `
codeunit 50001 Bar {
  procedure Run() var x: Codeunit Foo; begin end;
}`);
      await index.refreshFile(barPath);
      assert.strictEqual(index.getReferencers('Foo').size, 1);
      index.dispose();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('removeFile clears its declared and referrer edges', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alch-idx-'));
    try {
      fs.mkdirSync(path.join(tmp, 'A', 'src'), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'A', 'app.json'), JSON.stringify({
        id: 'a', name: 'A', publisher: 'p', version: '1.0.0.0',
      }));
      const fooPath = path.join(tmp, 'A', 'src', 'Foo.al');
      fs.writeFileSync(fooPath, 'codeunit 50000 Foo { }');
      const model = new WorkspaceModel([tmp]);
      await model.scan();
      const index = new SymbolIndex();
      await index.initialize(model, cache);
      assert.ok(index.getDeclarer('Foo'));
      index.removeFile(fooPath);
      assert.strictEqual(index.getDeclarer('Foo'), undefined);
      index.dispose();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('refreshFile with parse error retains last-good and marks pending', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alch-idx-'));
    try {
      fs.mkdirSync(path.join(tmp, 'A', 'src'), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'A', 'app.json'), JSON.stringify({
        id: 'a', name: 'A', publisher: 'p', version: '1.0.0.0',
      }));
      const fooPath = path.join(tmp, 'A', 'src', 'Foo.al');
      fs.writeFileSync(fooPath, 'codeunit 50000 Foo { }');
      const model = new WorkspaceModel([tmp]);
      await model.scan();
      const index = new SymbolIndex();
      await index.initialize(model, cache);
      assert.strictEqual(index.isSettled(), true);
      fs.writeFileSync(fooPath, 'codeunit 50000 Foo {');
      await index.refreshFile(fooPath);
      assert.ok(index.getDeclarer('Foo'), 'declarer retained from last-good');
      assert.strictEqual(index.isSettled(), false);
      fs.writeFileSync(fooPath, 'codeunit 50000 Foo { }');
      await index.refreshFile(fooPath);
      assert.strictEqual(index.isSettled(), true);
      index.dispose();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

suite('SymbolIndex — getTestsAffectedBy', () => {
  let cache: ParseCache;
  suiteSetup(async () => {
    cache = new ParseCache(WASM_DIR);
    await cache.initialize();
  });
  suiteTeardown(() => cache.dispose());

  test('saving file with declared symbol returns tests in other files referencing it', async () => {
    const model = new WorkspaceModel([path.join(FIX, 'multi-app')]);
    await model.scan();
    const index = new SymbolIndex();
    await index.initialize(model, cache);
    const mainFile = path.join(FIX, 'multi-app/MainApp/src/SomeCodeunit.Codeunit.al');
    const affected = index.getTestsAffectedBy(mainFile);
    assert.ok(affected, 'expected non-null');
    assert.ok(affected!.some(t => t.procName === 'ComputeDoubles'));
    index.dispose();
  });

  test('saving test file returns its own tests', async () => {
    const model = new WorkspaceModel([path.join(FIX, 'multi-app')]);
    await model.scan();
    const index = new SymbolIndex();
    await index.initialize(model, cache);
    const testFile = path.join(FIX, 'multi-app/MainApp.Test/src/SomeTest.Codeunit.al');
    const affected = index.getTestsAffectedBy(testFile);
    assert.ok(affected);
    assert.ok(affected!.some(t => t.procName === 'ComputeDoubles'));
    index.dispose();
  });

  test('returns null when saved file has parse errors', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alch-idx-'));
    try {
      fs.mkdirSync(path.join(tmp, 'A', 'src'), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'A', 'app.json'), JSON.stringify({
        id: 'a', name: 'A', publisher: 'p', version: '1.0.0.0',
      }));
      const fooPath = path.join(tmp, 'A', 'src', 'Foo.al');
      fs.writeFileSync(fooPath, 'codeunit 50000 Foo { }');
      const model = new WorkspaceModel([tmp]);
      await model.scan();
      const index = new SymbolIndex();
      await index.initialize(model, cache);
      fs.writeFileSync(fooPath, 'codeunit 50000 Foo {');
      await index.refreshFile(fooPath);
      assert.strictEqual(index.getTestsAffectedBy(fooPath), null);
      index.dispose();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('returns null when index not settled (file other than saved is pending)', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alch-idx-'));
    try {
      fs.mkdirSync(path.join(tmp, 'A', 'src'), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'A', 'app.json'), JSON.stringify({
        id: 'a', name: 'A', publisher: 'p', version: '1.0.0.0',
      }));
      const fooPath = path.join(tmp, 'A', 'src', 'Foo.al');
      const barPath = path.join(tmp, 'A', 'src', 'Bar.al');
      fs.writeFileSync(fooPath, 'codeunit 50000 Foo { }');
      fs.writeFileSync(barPath, 'codeunit 50001 Bar { }');
      const model = new WorkspaceModel([tmp]);
      await model.scan();
      const index = new SymbolIndex();
      await index.initialize(model, cache);
      fs.writeFileSync(barPath, 'codeunit 50001 Bar {');
      await index.refreshFile(barPath);
      assert.strictEqual(index.getTestsAffectedBy(fooPath), null);
      index.dispose();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

suite('SymbolIndex — symbol-index fixture (Sentinel-shaped)', () => {
  let cache: ParseCache;
  suiteSetup(async () => {
    cache = new ParseCache(WASM_DIR);
    await cache.initialize();
  });
  suiteTeardown(() => cache.dispose());

  test('AlertSESTM is referenced by AlertEngineSESTM and the test codeunit', async () => {
    const model = new WorkspaceModel([path.join(FIX, 'symbol-index')]);
    await model.scan();
    const index = new SymbolIndex();
    await index.initialize(model, cache);
    const refs = index.getReferencers('ALchemist.Tests.SymIdxMain.AlertSESTM');
    assert.ok(refs.size >= 2, `expected ≥2 referrers, got ${refs.size}`);
    index.dispose();
  });

  test('Saving AlertSESTM.Table.al returns the test that references it', async () => {
    const model = new WorkspaceModel([path.join(FIX, 'symbol-index')]);
    await model.scan();
    const index = new SymbolIndex();
    await index.initialize(model, cache);
    const tableFile = path.join(FIX, 'symbol-index/MainApp/src/AlertSESTM.Table.al');
    const affected = index.getTestsAffectedBy(tableFile);
    assert.ok(affected, 'expected non-null');
    assert.ok(affected!.some(t => t.procName === 'NewReturnsTrue'));
    index.dispose();
  });
});
