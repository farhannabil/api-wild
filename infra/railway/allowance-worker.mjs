// Run only for one approved order. Importing this file performs no work.
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {runAllowanceOperator} from './runtime/supplier-allowance-operator.mjs';
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  process.exitCode=await runAllowanceOperator({argv:process.argv.slice(2),env:process.env,
    write:value=>process.stdout.write(JSON.stringify(value)+'\n')});
}
