codeunit 50390 "Upstream Iter Fixture"
{
    trigger OnRun()
    var
        i: Integer;
        total: Integer;
    begin
        for i := 1 to 3 do begin
            total := total + i;
            Message('sum=' + Format(total));
        end;
    end;
}
