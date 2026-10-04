/**
 * The few node-forge calls appleSigner.ts makes (reading a .p12 bundle). node-forge
 * ships without types and comes in through passkit-generator.
 */
declare module "node-forge" {
  interface Bag {
    cert?: unknown;
    key?: unknown;
  }
  interface Pkcs12 {
    getBags(filter: { bagType: string }): Record<string, Bag[] | undefined>;
  }
  const forge: {
    asn1: { fromDer(bytes: string): unknown };
    pkcs12: { pkcs12FromAsn1(asn1: unknown, strict: boolean, password?: string): Pkcs12 };
    pki: {
      oids: Record<string, string>;
      certificateToPem(cert: unknown): string;
      privateKeyToPem(key: unknown): string;
    };
  };
  export default forge;
}
