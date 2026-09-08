// Force IPv4 for every DNS lookup: FortiClient black-holes the IPv6 path to some hosts.
const dns = require('dns');
const orig = dns.lookup;
dns.lookup = function lookup(hostname, options, callback) {
  if (typeof options === 'function') { callback = options; options = { family: 4 }; }
  else if (typeof options === 'number' || options == null) options = { family: 4 };
  else options = { ...options, family: 4 };
  return orig.call(dns, hostname, options, callback);
};
if (dns.promises && dns.promises.lookup) {
  const origP = dns.promises.lookup;
  dns.promises.lookup = (h, o) => origP.call(dns.promises, h, typeof o === 'number' || o == null ? { family: 4 } : { ...o, family: 4 });
}
