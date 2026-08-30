perl -e '
open(F, "<synonyms.txt") or die;
while (<F>) {
    chomp;
    next unless $_;
    my @syns = split(/,\s*/);
    @syns = map { s/^\s+|\s+$//g; $_ } @syns;
    foreach my $s (@syns) {
        $map{lc($s)} = \@syns;
    }
}

open(IN, "<input.tex") or die;
local $/;
my $orig_text = <IN>;
close(IN);

pos($orig_text) = 0;
while ($orig_text =~ /\b([a-zA-Z]+)\b/g) {
    my $w = $1;
    my $lw = lc($w);
    if (exists $map{$lw}) {
        my $p = pos($orig_text) - length($w);
        print "pos $p: $w -> " . join(",", @{$map{$lw}}) . "\n";
    }
}
'