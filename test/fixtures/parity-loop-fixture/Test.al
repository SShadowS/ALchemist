codeunit 50301 ParityTest
{
    Subtype = Test;

    [Test]
    procedure RunsLoop()
    var
        cu: Codeunit ParityCU;
    begin
        if cu.DoLoop() <> 15 then Error('expected 15');
    end;
}
