import type {CatalogSnapshot} from './catalog-display';
export const PUBLIC_ORIGIN:string;
export function normalizeCatalogue(pricing:unknown,providers:unknown[],details:unknown[],fetchedAt:string):CatalogSnapshot;
export function fetchPublicCatalogue(fetchImpl?:typeof fetch,options?:{timeoutMs?:number;now?:()=>number}):Promise<CatalogSnapshot>;
export function createCatalogueLoader(options:{bootstrap:CatalogSnapshot;fetchImpl?:typeof fetch;now?:()=>number;ttlMs?:number;failureBackoffMs?:number;timeoutMs?:number;waitForRefresh?:boolean}):()=>Promise<CatalogSnapshot>;
