#!/usr/bin/perl
# The live smoke test's one-file static server: the private apt repository is served over loopback HTTP so apt reports a real
# download size. A `file:` source would answer `0 B`, and the point of the estimate section is a real number, not a zero.
#
# It runs inside the throwaway container, bound to 127.0.0.1 only, and serves nothing but the directory it is given. It is not
# the module's code and decides nothing the test asserts.
use strict;
use warnings;
use IO::Socket::INET;

my ($root, $port) = @ARGV;
die "usage: serve.pl <dir> <port>\n" unless defined $root && defined $port;

my $server = IO::Socket::INET->new(
  LocalAddr => "127.0.0.1", LocalPort => $port, Listen => 8, ReuseAddr => 1, Proto => "tcp",
) or die "listen on 127.0.0.1:$port: $!\n";

while (my $client = $server->accept) {
  my $request = <$client>;
  my ($path) = $request && $request =~ m{^GET (\S+) } ? ($1) : ("");
  while (my $header = <$client>) { last if $header =~ /^\r?\n$/; }
  $path =~ s/%([0-9A-Fa-f]{2})/chr(hex($1))/ge;
  $path =~ s{\.\.}{}g;
  my $file = "$root$path";
  if (-f $file) {
    open(my $fh, "<", $file) or do { print $client "HTTP/1.0 404 Not Found\r\nContent-Length: 0\r\n\r\n"; close $client; next; };
    binmode $fh;
    local $/;
    my $body = <$fh>;
    close $fh;
    print $client "HTTP/1.0 200 OK\r\nContent-Length: " . length($body) . "\r\n\r\n$body";
  } else {
    print $client "HTTP/1.0 404 Not Found\r\nContent-Length: 0\r\n\r\n";
  }
  close $client;
}
