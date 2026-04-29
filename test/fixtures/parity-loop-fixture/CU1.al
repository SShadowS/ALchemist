codeunit 50300 ParityCU
{
    procedure DoLoop(): Integer
    var
        i: Integer;
        sum: Integer;
    begin
        for i := 1 to 5 do
            sum += i;
        exit(sum);
    end;
}
