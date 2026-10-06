/** Shapes of the generated endpoint catalog (see scripts/build-catalog.ts). */
export type CatalogParam = {
  name: string;
  type: string;
  required: boolean;
  description: string;
  children?: CatalogParam[];
};

export type CatalogEntry = {
  id: string; // e.g. "order.get_order_list"
  module: string; // e.g. "order"
  sdkProperty: string; // e.g. "order" (sdk.order)
  sdkMethod: string; // e.g. "getOrderList"
  httpMethod: "GET" | "POST";
  path: string; // e.g. "/order/get_order_list"
  auth: boolean;
  apiType: string; // Shop | Merchant | Public | User | Principal | unknown
  access: "read" | "write";
  description: string;
  request: CatalogParam[];
  response: CatalogParam[];
};
