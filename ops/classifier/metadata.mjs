// Only an explicit, valid API publication timestamp is usable. Never infer from
// Wiki MM/DD, registration/import time, receipts or the current year.
export function hasPublicationDate(metadata) {
  const value=metadata?.publishedAt;
  if(typeof value!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value)||!Number.isFinite(Date.parse(value)))return false;
  const [year,month,day]=value.slice(0,10).split('-').map(Number);
  return month>=1&&month<=12&&day>=1&&day<=new Date(Date.UTC(year,month,0)).getUTCDate();
}
export function mergeMetadata(...values) {
  let merged={};
  for(const value of values){
    if(!value||typeof value!=='object'||Array.isArray(value))continue;
    const {publishedAt,...rest}=value;
    merged={...merged,...rest};
    if(hasPublicationDate(value))merged.publishedAt=publishedAt;
  }
  return merged;
}

// Local retry policy, not a YouTube quota claim. Kept in the DO, independent of
// classification acknowledgements. Duplicate notifications never slide the deadline.
export function metadataWait(item, revision, now) {
  if(hasPublicationDate(item.metadata))return item;
  if(item.metadataRetry?.revision===revision&&item.metadataRetry.nextCheckAt>now)return item;
  return {...item,metadataRetry:{revision,checkedAt:now,nextCheckAt:new Date(Date.parse(now)+6*3600000).toISOString()}};
}
