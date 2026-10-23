/** Private ranges first, so invites list the likely-right address first. */
export function rankAddresses(ips: string[]): string[] {
  const score = (ip: string) => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 2 : 3);
  return [...new Set(ips)]
    .filter((ip) => ip && ip !== '0.0.0.0' && !ip.startsWith('127.') && !ip.startsWith('169.254.'))
    .sort((a, b) => score(a) - score(b));
}
