#!/usr/bin/perl
#
# ESC/POS bridge for the Epson TM-T88V — Perl edition.
#
# Identical behaviour to escpos-bridge.js, but runs on the Perl that ships with
# macOS, so nothing has to be installed.
#
# WHY THIS EXISTS
# ---------------
# The TM-T88V speaks ESC/POS. Epson no longer ships a Mac driver, so macOS
# assigns "Epson 24-Pin Series" — an ESC/P2 dot-matrix driver. The printer can't
# read ESC/P2 and prints the escape bytes as characters ("binary junk"). We build
# ESC/POS ourselves and spool it with `lp -o raw`, which skips every CUPS filter
# so no driver ever touches the data.
#
#   perl escpos-bridge.pl              # serve on 127.0.0.1:9100
#   perl escpos-bridge.pl --selftest   # print one test docket and exit
#   perl escpos-bridge.pl --dry-run    # write ESC/POS to stdout, don't spool
#
# Only core modules are used: JSON::PP, Unicode::Normalize, IO::Socket::INET.

use strict;
use warnings;
use IO::Socket::INET;
use JSON::PP;
use Unicode::Normalize qw(NFD);
use POSIX qw(strftime);

my $PORT    = $ENV{BRIDGE_PORT}  || 9100;
my $QUEUE   = $ENV{BRIDGE_QUEUE} || 'EPSON_TM_T88V';
my $COLS    = 42;                       # Font A on 80mm roll
my $DRY     = grep { $_ eq '--dry-run' } @ARGV;

$SIG{PIPE} = 'IGNORE';                  # a dead `lp` must not kill the server

# ---------------- ESC/POS primitives ----------------
my $ESC = chr(27);
my $GS  = chr(29);
my %CMD = (
    init        => $ESC . '@',
    align_left  => $ESC . 'a' . chr(0),
    align_mid   => $ESC . 'a' . chr(1),
    bold_on     => $ESC . 'E' . chr(1),
    bold_off    => $ESC . 'E' . chr(0),
    big_on      => $GS  . '!' . chr(0x11),   # double width + height
    big_off     => $GS  . '!' . chr(0),
    cut         => $GS  . 'V' . chr(66) . chr(3),        # partial cut, feed 3
    drawer      => $ESC . 'p' . chr(0) . chr(25) . chr(250),
);

# ---------------- text helpers ----------------

# Reduce to printable ASCII. NFD first so accents keep their base letter:
# "Pokemon", not "Pokmon".
sub ascii {
    my $s = shift;
    return '' unless defined $s;
    $s = NFD("$s");
    $s =~ s/\p{M}//g;
    $s =~ s/[\x{2018}\x{2019}\x{201A}\x{201B}]/'/g;
    $s =~ s/[\x{201C}\x{201D}\x{201E}]/"/g;
    $s =~ s/[\x{2013}\x{2014}\x{2011}]/-/g;
    $s =~ s/\x{2026}/.../g;
    $s =~ s/\x{00A0}/ /g;
    $s =~ s/[^\x20-\x7e]//g;
    $s =~ s/ {2,}/ /g;
    $s =~ s/^\s+//; $s =~ s/\s+$//;
    return $s;
}

sub money {
    my $n = shift;
    $n = 0 unless defined $n && $n =~ /^-?[\d.]+$/;
    return ($n < 0 ? '-$' : '$') . sprintf('%.2f', abs($n));
}

sub wrap_text {
    my ($s, $w) = @_;
    $w ||= $COLS;
    my @words = grep { length } split /\s+/, ascii($s);
    my (@lines, $cur);
    $cur = '';
    for my $word (@words) {
        if (!length $cur)                              { $cur = $word }
        elsif (length($cur) + 1 + length($word) <= $w) { $cur .= ' ' . $word }
        else { push @lines, $cur; $cur = $word }
        while (length($cur) > $w) {                    # single word too long
            push @lines, substr($cur, 0, $w);
            $cur = substr($cur, $w);
        }
    }
    push @lines, $cur if length $cur;
    return @lines ? @lines : ('');
}

# Left text and right text on one line. If they don't fit, wrap the label and
# right-align the amount underneath.
sub pair {
    my ($l, $r) = (ascii($_[0]), ascii($_[1]));
    my $gap = $COLS - length($l) - length($r);
    return $l . (' ' x $gap) . $r if $gap >= 1;
    return join("\n", wrap_text($l)) . "\n" . (' ' x ($COLS - length($r))) . $r;
}

sub rule { return '-' x $COLS }

sub now_str { return strftime('%d/%m/%Y %I:%M %p', localtime) }

# ---------------- documents ----------------

sub doc_header {
    my ($out, $store) = @_;
    $$out .= $CMD{align_mid};
    if (my $n = ascii($store->{name})) {
        $$out .= $CMD{big_on} . $CMD{bold_on} . $n . "\n" . $CMD{bold_off} . $CMD{big_off};
    }
    for my $f (qw(address phone)) {
        my $v = ascii($store->{$f});
        $$out .= $v . "\n" if length $v;
    }
    my $abn = ascii($store->{abn});
    $$out .= "ABN $abn\n" if length $abn;
    $$out .= $CMD{align_left};
}

sub doc_footer {
    my ($out, $store, $opts, $cash) = @_;
    $$out .= rule() . "\n" . $CMD{align_mid};
    my $f = ascii($store->{footer});
    if (length $f) { $$out .= "$_\n" for wrap_text($f) }
    $$out .= now_str() . "\n" . $CMD{align_left};
    $$out .= $CMD{drawer} if $opts->{drawer} && $cash;
    $$out .= $CMD{cut} unless defined $opts->{cut} && !$opts->{cut};
}

sub build_receipt {
    my ($p)   = @_;
    my $store = $p->{store}   || {};
    my $sale  = $p->{sale}    || {};
    my $opts  = $p->{options} || {};

    my $out = $CMD{init};
    doc_header(\$out, $store);

    $out .= rule() . "\n";
    $out .= $CMD{align_mid} . $CMD{bold_on} . "TAX INVOICE\n" . $CMD{bold_off} . $CMD{align_left};

    my $ts = $sale->{ts} ? int($sale->{ts} / 1000) : time;
    $out .= pair($sale->{no} // '', strftime('%d/%m/%Y %I:%M %p', localtime($ts))) . "\n";
    if ($sale->{servedBy}) { $out .= "$_\n" for wrap_text('Served by: ' . ascii($sale->{servedBy})) }
    if ($sale->{customer}) { $out .= "$_\n" for wrap_text('Customer: '  . ascii($sale->{customer})) }
    if ($sale->{contact}) {
        my $c = $sale->{contact};
        $out .= "$_\n" for wrap_text(($c =~ /\@/ ? 'Email: ' : 'Phone: ') . ascii($c));
    }
    if (($sale->{order} // '') eq 'pickup') {
        $out .= $CMD{bold_on} . "Order: PICK UP LATER\n" . $CMD{bold_off};
    } else {
        $out .= "Order: Served on the spot\n";
    }
    $out .= rule() . "\n";

    for my $it (@{ $sale->{items} || [] }) {
        $out .= "$_\n" for wrap_text($it->{name});
        $out .= pair(($it->{qty} // 0) . ' x ' . money($it->{price}),
                     money(($it->{price} // 0) * ($it->{qty} // 0))) . "\n";
    }

    $out .= rule() . "\n";
    $out .= pair('Subtotal (ex GST)', money($sale->{sub})) . "\n";
    $out .= pair('GST (' . ($sale->{rate} // 10) . '%)', money($sale->{gst})) . "\n";
    $out .= $CMD{bold_on} . pair('TOTAL', money($sale->{total})) . "\n" . $CMD{bold_off};
    $out .= 'Total price includes GST ' . money($sale->{gst}) . "\n\n";

    my $cash = (($sale->{method} // '') eq 'cash');
    if ($cash) {
        if ($sale->{rounding}) {
            $out .= pair('Rounding', ($sale->{rounding} > 0 ? '+' : '') . money($sale->{rounding})) . "\n";
        }
        $out .= pair('Rounded total', money($sale->{paid})) . "\n";
        $out .= pair('CASH', money(defined $sale->{tendered} ? $sale->{tendered} : $sale->{paid})) . "\n";
        $out .= pair('Change', money($sale->{change})) . "\n" if defined $sale->{change};
    } else {
        $out .= pair('CARD', money($sale->{paid})) . "\n";
    }

    doc_footer(\$out, $store, $opts, $cash);
    return $out;
}

sub build_report {
    my ($p)   = @_;
    my $store = $p->{store}   || {};
    my $rep   = $p->{report}  || {};
    my $opts  = $p->{options} || {};

    my $out = $CMD{init};
    doc_header(\$out, $store);
    $out .= rule() . "\n" . $CMD{align_mid} . $CMD{bold_on}
          . ascii($rep->{title} || 'REPORT') . "\n" . $CMD{bold_off};
    if ($rep->{subtitle}) { $out .= "$_\n" for wrap_text($rep->{subtitle}) }
    $out .= $CMD{align_left} . rule() . "\n";

    for my $row (@{ $rep->{rows} || [] }) {
        if (!ref $row) { $out .= rule() . "\n"; next; }        # "-" separator
        my ($label, $value, $bold) = @$row;
        $out .= $CMD{bold_on} if $bold;
        $out .= pair($label, $value) . "\n";
        $out .= $CMD{bold_off} if $bold;
    }

    doc_footer(\$out, $store, $opts, 0);
    return $out;
}

# ---------------- spooling ----------------

sub spool {
    my ($bytes) = @_;
    if ($DRY) { binmode(STDOUT); print $bytes; return 'dry-run' }

    # -o raw makes CUPS skip every filter, so the ESC/P2 driver never sees this.
    open(my $lp, '|-', 'lp', '-d', $QUEUE, '-o', 'raw')
        or die "cannot run lp: $!";
    binmode($lp);
    print $lp $bytes;
    unless (close $lp) {
        die $! ? "lp failed: $!" : 'lp exited ' . ($? >> 8);
    }
    return 'spooled';
}

# ---------------- HTTP ----------------

# Access-Control-Allow-Private-Network is what lets an HTTPS page (the till on
# Netlify) reach this plain-HTTP server on localhost. Chrome 104+ blocks such
# "private network" requests unless the preflight comes back with it, and
# Chrome 142+ enforces that with no fallback. Without this header the till gets
# a bare "Failed to fetch" and silently drops back to the broken print dialog.
my $CORS = "Access-Control-Allow-Origin: *\r\n"
         . "Access-Control-Allow-Methods: POST, OPTIONS\r\n"
         . "Access-Control-Allow-Headers: Content-Type\r\n"
         . "Access-Control-Allow-Private-Network: true\r\n"
         . "Access-Control-Max-Age: 86400\r\n";

sub respond {
    my ($c, $status, $body, $type) = @_;
    $type ||= 'application/json';
    print $c "HTTP/1.1 $status\r\n${CORS}Content-Type: $type\r\n"
           . 'Content-Length: ' . length($body) . "\r\nConnection: close\r\n\r\n$body";
}

sub serve {
    my $srv = IO::Socket::INET->new(
        LocalAddr => '127.0.0.1', LocalPort => $PORT,
        Proto => 'tcp', Listen => 8, ReuseAddr => 1,
    ) or die "cannot listen on 127.0.0.1:$PORT — $!\n";

    $| = 1;
    print "[bridge] listening on http://127.0.0.1:$PORT  ->  queue \"$QUEUE\"\n";

    while (my $c = $srv->accept) {
        eval {
            $c->timeout(10);
            my $line = <$c> // '';
            my ($method, $path) = $line =~ m{^(\w+)\s+(\S+)};
            $method //= ''; $path //= '';

            my $len = 0;
            while (my $h = <$c>) {
                last if $h =~ /^\r?\n$/;
                $len = $1 if $h =~ /^Content-Length:\s*(\d+)/i;
            }

            if ($method eq 'OPTIONS')                  { respond($c, '204 No Content', '') }
            elsif ($method eq 'GET' && $path eq '/health') {
                respond($c, '200 OK',
                    encode_json({ ok => JSON::PP::true, queue => $QUEUE, cols => $COLS,
                                 fields => ['order', 'contact'] }));
            }
            elsif ($method eq 'POST' && $path eq '/print') {
                my $body = '';
                read($c, $body, $len) if $len && $len < 1_000_000;
                my $res = eval {
                    my $p = JSON::PP->new->utf8->decode($body);
                    my $bytes = (($p->{type} // '') eq 'report')
                              ? build_report($p) : build_receipt($p);
                    my $how = spool($bytes);
                    encode_json({ ok => JSON::PP::true, how => $how,
                                  bytes => length($bytes) });
                };
                if ($res) { respond($c, '200 OK', $res) }
                else {
                    my $e = $@ || 'unknown error'; chomp $e;
                    warn "[bridge] print failed: $e\n";
                    respond($c, '500 Internal Server Error',
                        encode_json({ ok => JSON::PP::false, error => "$e" }));
                }
            }
            else { respond($c, '404 Not Found', encode_json({ ok => JSON::PP::false })) }
        };
        warn "[bridge] connection error: $@" if $@;
        close $c;
    }
}

# ---------------- entry ----------------

if (grep { $_ eq '--selftest' } @ARGV) {
    my $bytes = build_receipt({
        store => { name => 'Remactables', address => '111 Cecil St',
                   abn => '12 345 678 901',
                   footer => 'Bridge self-test - not a real sale' },
        sale  => { no => 'SELFTEST', ts => time * 1000, servedBy => 'bridge',
                   items => [ { name => 'Prizm Basketball 2025-26 Hobby Box', qty => 1, price => 449.95 },
                              { name => 'Ultra Pro Penny Sleeves 100ct',      qty => 3, price => 4.95  } ],
                   sub => 422.59, rate => 10, gst => 42.26, total => 464.85,
                   method => 'cash', rounding => 0, paid => 464.85,
                   tendered => 500, change => 35.15 },
        options => { cut => 1, drawer => 0 },       # no drawer kick during a test
    });
    my $ok = eval { spool($bytes); 1 };
    if ($ok) { print "Self-test sent to \"$QUEUE\" (" . length($bytes) . " bytes).\n"; exit 0 }
    my $e = $@; chomp $e;
    print STDERR "Self-test FAILED: $e\n";
    exit 1;
}

serve();
