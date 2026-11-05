import {readFileSync} from 'node:fs';
import {posix} from 'node:path';
export function missingDocLinks(files,read){
 const tracked=new Set(files),hits=[];
 for(const file of files){
  if(!/\.(?:md|txt)$/.test(file)||file.startsWith('config/policy/'))continue;
  const text=read(file);
  // Root-qualified prose citations and local Markdown targets must ship.
  for(const ref of text.matchAll(/\b(?:docs|reference|provian-[a-z-]+)\/(?:[A-Za-z0-9_.+-]+\/)*[A-Za-z0-9_.+-]+\.(?:md|txt)\b/g)){
   const target=ref[0];if(tracked.has(target)||tracked.has(posix.normalize(posix.join(posix.dirname(file),target))))continue;
   // A repository path inside an external URL belongs to that external repository.
   const prefix=text.slice(Math.max(0,ref.index-160),ref.index).split(/\s/).at(-1);
   if(/https?:\/\//.test(prefix))continue;
   hits.push(`${file}: absent document citation ${target}`);
  }
  for(const ref of text.matchAll(/\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+["\x27][^"\x27]*["\x27])?\s*\)/g)){
   const target=(ref[1]??ref[2]).split('#')[0];if(!target||/^[a-z]+:|^\/\//i.test(target)||! /\.(?:md|txt)$/i.test(target))continue;
   const resolved=target.startsWith('/') ? 'provian-website/public'+decodeURIComponent(target) : posix.normalize(posix.join(posix.dirname(file),decodeURIComponent(target)));
   if(!tracked.has(resolved))hits.push(`${file}: absent Markdown document ${target}`);
  }
 }
 return [...new Set(hits)];
}
