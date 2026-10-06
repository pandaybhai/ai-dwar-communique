/**
 * One message of a test reply, in the order the customer would get it
 * (replySendOrder in reply-order.server.ts). Browser-safe: types only.
 */
export type SendStep =
  | { kind: "text"; text: string }
  | {
      kind: "picture";
      title: string;
      image_url: string;
      caption: string;
      price: number | null;
      currency: string | null;
    };
