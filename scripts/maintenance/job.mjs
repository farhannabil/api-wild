// Scheduled task entry: preserve only fixed/sanitized controller output locally.
import fs from 'node:fs/promises';import{main}from'./controller.mjs';
import {HOME as home} from './platform.mjs';
const events=[],log=console.log,error=console.error;
console.log=value=>events.push(String(value).slice(0,2000));console.error=value=>events.push(String(value).slice(0,2000));
try{await main('tick');}finally{console.log=log;console.error=error;await fs.writeFile(home+'/last-job.json',JSON.stringify({checkedAt:new Date().toISOString(),pid:process.pid,exitCode:process.exitCode??0,events},null,2)+'\n');}
