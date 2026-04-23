// JoyID deployment URLs. These are JoyID's own — not dApp-specific.

export type JoyIDNetwork = 'mainnet' | 'testnet';

export function resolveJoyIDAppUrl(network: JoyIDNetwork): string {
  return network === 'mainnet'
    ? 'https://app.joy.id'
    : 'https://testnet.joyid.dev';
}
