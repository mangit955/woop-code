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

my @tokens;
pos($orig_text) = 0;
while ($orig_text =~ /(\b[a-zA-Z]+\b)/g) {
    my $w = $1;
    my $start = pos($orig_text) - length($w);
    my $lw = lc($w);
    if (exists $map{$lw}) {
        push @tokens, {
            word => $w,
            start => $start,
            len => length($w),
            syns => $map{$lw}
        };
    }
}

sub test_text {
    my ($choices) = @_; # array ref of index into syns for each token
    my $new_text = $orig_text;
    # Apply replacements from end to start to not mess up offsets
    for (my $i = $#tokens; $i >= 0; $i--) {
        my $t = $tokens[$i];
        my $c = $choices->[$i];
        my $syn = $t->{syns}[$c];
        # Preserve capitalization of original word if possible
        if ($t->{word} =~ /^[A-Z]/) {
            $syn = ucfirst(lc($syn));
        } else {
            $syn = lc($syn);
        }
        substr($new_text, $t->{start}, $t->{len}, $syn);
    }
    open(OUT, ">input.tex") or die;
    print OUT $new_text;
    close(OUT);

    system("pdflatex main.tex > /dev/null 2>&1");
    open(LOG, "<main.log") or die;
    local $/;
    my $log = <LOG>;
    close(LOG);
    my @overfull = ($log =~ /(Overfull \\hbox .*)/g);
    return scalar(@overfull);
}

# Test all zeros (original words)
my @choices = (0) x scalar(@tokens);
print "Original overfull count: " . test_text(\@choices) . "\n";
'