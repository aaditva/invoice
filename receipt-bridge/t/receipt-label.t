#!/usr/bin/perl
# A barcode slip for a toploader: no header, no footer, just the name, the
# price and a Code 128 barcode, cut straight after the last line with no extra
# paper (GS V 66 0). A 12-digit in-store code goes in set C with wide bars.
#   perl receipt-bridge/t/receipt-label.t
use strict;
use warnings;
use Test::More;
use FindBin;

require "$FindBin::Bin/../escpos-bridge.pl";

my $GS = chr(29);
my $out = build_label({ label => { name => 'Charizard ex 199/165', price => 12.5, code => '212345678903' } });

my $bars = "{C" . join('', map { chr } 21, 23, 45, 67, 89, 3);
is $out,
   "\e\@"                                     # init
 . "\ea\x01"                                  # centred
 . "\eE\x01Charizard ex 199/165\n\eE\x00"     # name, bold
 . "${GS}!\x11\eE\x01\$12.50\n\eE\x00${GS}!\x00"   # price, double size
 . "${GS}h\x40${GS}w\x03${GS}H\x02${GS}f\x01" # 64 dots high, 3-dot bars, digits underneath in font B
 . "${GS}k\x49\x08$bars"                      # Code 128, set C, 6 pairs
 . "${GS}V\x42\x00",                          # cut at the blade, no extra feed
   'exact bytes of one slip';

unlike $out, qr/TAX INVOICE|ABN|\d\d\/\d\d\/\d{4}/, 'no receipt header, footer or date';
unlike $out, qr/\n\n/, 'no blank lines';
ok $out =~ /\Q${GS}V\E\x42\x00\z/, 'ends on the cut, nothing fed after it';

my $three = build_label({ label => { name => 'X', price => 1, code => '212345678903' }, copies => 3 });
is scalar(() = $three =~ /\Q${GS}V\E\x42\x00/g), 3, 'three copies = three slips, each cut';
is scalar(() = $three =~ /\e\@/g), 1, 'one init for the whole job';

my $long = build_label({ label => { name => 'A ' x 60, price => 1, code => '212345678903' } });
my ($name) = $long =~ /\eE\x01(.*?)\eE\x00/s;
is scalar(split /\n/, $name), 2, 'a long name is cut to two lines';

my $alpha = build_label({ label => { name => 'X', price => 1, code => 'AB12' } });
like $alpha, qr/\Q${GS}k\E\x49\x06\{BAB12/, 'letters use set B';
my $odd = build_label({ label => { name => 'X', price => 1, code => '12345' } });
like $odd, qr/\Q${GS}k\E\x49\x07\{B12345/, 'an odd number of digits uses set B';

ok !eval { build_label({ label => { name => 'X', price => 1, code => '' } }); 1 }, 'no code: refuses';
is scalar(() = build_label({ label => { name => 'X', price => 1, code => '1' }, copies => 999 }) =~ /\Q${GS}V\E/g), 100, 'copies capped at 100';

done_testing;
