// Syntax validation only: this does not verify ownership, SMS delivery or number type.
export function normalizeInternationalPhone(value){
 if(typeof value!=='string')return null;
 const phone=value.trim().replace(/[\s().-]/g,'');
 return /^\+[1-9]\d{7,14}$/.test(phone)?phone:null;
}
