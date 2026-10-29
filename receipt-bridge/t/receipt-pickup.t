#!/usr/bin/perl
# A pick-up docket leads with the order number, triple size, and prints the
# pick-up date; a sale served on the spot has neither.
#   perl receipt-bridge/t/receipt-pickup.t
use strict;
use warnings;
use Test::More;
use FindBin;

require "$FindBin::Bin/../escpos-bridge.pl";

my $GS = chr(29);
my $pickup = build_receipt({ store => { name => 'Test' },
    sale => { no => 'INV-SM-0042', order => 'pickup', orderNo => 'SMP0007', pickupWhen => 'from Sat, 31 Oct',
              pickupCode => 'PUABCDEFG', ts => '2026-10-29T02:00:00Z', items => [] } });
like $pickup, qr{^\e\@\ea\x01\Q${GS}!\E\x22\eE\x01SMP0007\n}, 'order number is the first line, triple size';
like $pickup, qr{Pick up from Sat, 31 Oct}, 'pick-up date printed';

my $now = build_receipt({ store => { name => 'Test' },
    sale => { no => 'INV-SM-0043', order => 'now', orderNo => 'SMP0008', ts => '2026-10-29T02:00:00Z', items => [] } });
unlike $now, qr{SMP0008}, 'no order number on a sale served on the spot';

done_testing;
