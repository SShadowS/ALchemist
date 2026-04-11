codeunit 50000 Scratch
{
    trigger OnRun()
    var
        Price: Decimal;
        Qty: Integer;
        Total: Decimal;
        i: Integer;
    begin
        Price := 29.95;
        Qty := 4;
        Total := Price * Qty;
        Message('Total: %1', Total);

        for i := 1 to 5 do
            Message('Item %1: %2', i, Price * i);
    end;
}
