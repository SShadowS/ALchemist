namespace ALchemist.Tests.MainAppTest;

using ALchemist.Tests.MainApp;

codeunit 50100 SomeTestCodeunit
{
    Subtype = Test;

    [Test]
    procedure ComputeDoubles()
    var
        Sut: Codeunit SomeCodeunit;
    begin
        if Sut.Compute(3) <> 6 then Error('expected 6');
    end;

    // Stacked attribute form. Combined `[Test, HandlerFunctions(...)]` is a
    // known gap in the current regex-based discoverer (see testDiscovery
    // tests) — Plan B's tree-sitter discovery will fix that.
    [Test]
    [HandlerFunctions('MessageHandler')]
    procedure ComputeZero()
    var
        Sut: Codeunit SomeCodeunit;
    begin
        if Sut.Compute(0) <> 0 then Error('expected 0');
    end;

    [MessageHandler]
    procedure MessageHandler(Msg: Text[1024])
    begin
    end;
}
