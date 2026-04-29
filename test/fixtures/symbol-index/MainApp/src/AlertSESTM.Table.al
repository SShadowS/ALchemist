namespace ALchemist.Tests.SymIdxMain;

table 50000 AlertSESTM
{
    fields
    {
        field(1; Id; Integer) { }
        field(2; Code; Code[20]) { }
    }
    keys
    {
        key(PK; Id) { Clustered = true; }
    }
}
