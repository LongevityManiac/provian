const path=require('node:path');
module.exports=function(config,root){
 const base=config.resolver.resolveRequest;
 const app=path.join(root,'App.tsx'),runtime=path.join(root,'src/core/protocol/runtime.ts');
 const directory=path.join(root,'scripts/recourse/native');
 config.resolver.resolveRequest=(context,name,platform)=>{
   const result=base?base(context,name,platform):context.resolveRequest(context,name,platform);
   if(result.type!=='sourceFile'||context.originModulePath.startsWith(directory+path.sep))return result;
   if(result.filePath===app)return{...result,filePath:path.join(directory,'App.tsx')};
   if(result.filePath===runtime)return{...result,filePath:path.join(directory,'runtime.ts')};
   return result;
 };
 return config;
};
