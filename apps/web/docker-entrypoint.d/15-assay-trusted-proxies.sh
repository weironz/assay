#!/bin/sh
set -eu
set -f

# Exact IPv4 addresses only. An environment value must never introduce another
# nginx directive, a subnet-wide trust rule, or a shell command.
trusted_tmp=$(mktemp /etc/nginx/assay-trusted-proxies.XXXXXX)
trap 'rm -f "$trusted_tmp"' EXIT HUP INT TERM
for address in $(printf '%s' "${ASSAY_TRUSTED_PROXY_IPS:-}" | tr ',\n\t' '   '); do
    if ! printf '%s\n' "$address" | awk -F. '
        NF != 4 { exit 1 }
        { for (i=1; i<=4; i++) {
            if ($i !~ /^[0-9]+$/ || length($i)>3 || $i+0>255 ||
                (length($i)>1 && substr($i,1,1)=="0")) exit 1
        }}'; then
        echo 'ASSAY_TRUSTED_PROXY_IPS must contain exact IPv4 addresses' >&2
        exit 1
    fi
    printf 'set_real_ip_from %s;\n' "$address" >> "$trusted_tmp"
done
chmod 644 "$trusted_tmp"
mv -f "$trusted_tmp" /etc/nginx/assay-trusted-proxies.conf
