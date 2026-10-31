#!/usr/bin/perl
# A website order prints its docket: the order number big on top, WEBSITE ORDER
# instead of TAX INVOICE, the till's lines, the extra totals, the paid line, and
# (a pickup) the barcode with its own note. No cash drawer kick.
#   perl receipt-bridge/t/receipt-docket.t
use strict;
use warnings;
use Test::More;
use FindBin;
use JSON::PP;

require "$FindBin::Bin/../escpos-bridge.pl";

my $GS = chr(29);
my $sale = {
    no => 'WEB-1001', orderNo => '#1001', order => 'pickup', method => 'online', pickupCode => 'PUABCDEFG',
    ts => '2026-10-29T02:00:00Z', sub => 18.18, gst => 1.82, total => 20, rate => 10,
    items => [{ name => 'Booster Pack', qty => 2, price => 10 }],
    docket => {
        title => 'WEBSITE ORDER',
        lines => [['STORE PICKUP', JSON::PP::true], ['Customer: Sam Lee'], ['Phone: 0400 000 000'],
                  ['Address:'], ['  1 Test St'], ['Gift note: Happy birthday']],
        totals => [['Discount', -2]],
        paid => ['PAID ONLINE - Visa (Stripe)', 20],
        barcodeNote => 'Scan this when the customer collects it',
    },
};
my $out = build_receipt({ store => { name => 'Test' }, sale => $sale, options => { cut => 1, drawer => 1 } });

like   $out, qr{^\e\@\ea\x01\Q${GS}!\E\x22\eE\x01#1001\n}, 'order number first, triple size';
like   $out, qr{WEBSITE ORDER\n}, 'website order title';
unlike $out, qr{TAX INVOICE}, 'not a tax invoice';
like   $out, qr{\eE\x01STORE PICKUP\n\eE\x00}, 'shipping option in bold';
like   $out, qr{\n  1 Test St\n}, 'address line indented';
like   $out, qr{Gift note: Happy birthday}, 'checkout note printed';
like   $out, qr{Discount +-\$2\.00}, 'extra total';
like   $out, qr{PAID ONLINE - Visa \(Stripe\) +\$20\.00}, 'paid line';
unlike $out, qr{CARD|CASH|Served by}, 'no till payment or staff lines';
like   $out, qr{Scan this when the customer collects it}, 'barcode note';
unlike $out, qr{\ep\x00}, 'no drawer kick';

done_testing;
