// Server import boundary: no supplier credential, customer key or billing flag is used.
import snapshot from '@/data/subrouter-catalogue.json';
import {createCatalogueLoader} from './subrouter-catalogue.mjs';
import type {CatalogSnapshot} from './catalog-display';
export const getSubRouterCatalogue=createCatalogueLoader({bootstrap:snapshot as CatalogSnapshot});
