namespace ALchemist.Tests.SymIdxTest;

using ALchemist.Tests.SymIdxMain;

codeunit 50100 AlertEngineTestSESTM
{
    Subtype = Test;

    [Test]
    procedure NewReturnsTrue()
    var
        Engine: Codeunit AlertEngineSESTM;
        Alert: Record AlertSESTM;
    begin
        if not Engine.New() then Error('expected true');
    end;
}
