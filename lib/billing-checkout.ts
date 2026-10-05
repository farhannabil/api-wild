export type CheckoutRequestOrder={pack:string;request_id:string;status:string};
type CheckoutStorage=Pick<Storage,'getItem'|'removeItem'>;

export function forgetCheckoutRequest(order:Pick<CheckoutRequestOrder,'pack'|'request_id'>,storage:CheckoutStorage){
  const key='apiwild-checkout-'+order.pack;
  if(storage.getItem(key)===order.request_id)storage.removeItem(key);
}

export function forgetFinishedCheckoutRequests(orders:CheckoutRequestOrder[],storage:CheckoutStorage){
  for(const order of orders){
    if(['paid','partially_refunded','refunded','expired','failed'].includes(order.status))forgetCheckoutRequest(order,storage);
  }
}
