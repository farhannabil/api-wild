// Importing performs no work. Invoke only for one verified request reference.
import {pathToFileURL} from 'node:url';import path from 'node:path';
import {runReservationExpiryOperator} from './runtime/reservation-expiry-operator.mjs';
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 process.exitCode=await runReservationExpiryOperator({argv:process.argv.slice(2),env:process.env,write:value=>process.stdout.write(JSON.stringify(value)+'\n')});
}
