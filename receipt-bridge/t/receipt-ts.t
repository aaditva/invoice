#!/usr/bin/perl
# build_receipt must print the sale's own date/time, whether the till sends
# `ts` as an ISO string or --selftest sends epoch milliseconds.
#   perl receipt-bridge/t/receipt-ts.t
use strict;
use warnings;
use Test::More;
use FindBin;
use POSIX qw(tzset);

BEGIN { $ENV{TZ} = 'Australia/Melbourne'; tzset() }

my @warnings;
$SIG{__WARN__} = sub { push @warnings, @_ };

require "$FindBin::Bin/../escpos-bridge.pl";

sub receipt_for {
    my ($ts) = @_;
    return build_receipt({ store => { name => 'Test' },
                           sale  => { no => 'INV-1', ts => $ts, items => [] } });
}

like receipt_for('2026-10-03T02:50:00.000Z'), qr{INV-1 +03/10/2026 12:50 PM},
    'ISO string (UTC) printed in local time';
like receipt_for('2026-10-03T12:50:00+10:00'), qr{03/10/2026 12:50 PM},
    'ISO string with an offset';
like receipt_for('2026-10-03T12:50:00'), qr{03/10/2026 12:50 PM},
    'ISO string without a zone is local time';
like receipt_for(1790995800000), qr{03/10/2026 12:50 PM},
    'epoch milliseconds (the --selftest path)';
unlike receipt_for('garbage'), qr{1970}, 'unparseable ts falls back to now';
is_deeply \@warnings, [], 'no warnings';

done_testing;
