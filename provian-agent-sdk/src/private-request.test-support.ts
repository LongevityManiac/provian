import {openPrivateAuthenticatedRequest} from '../../provian-backend/src/core/meter/private-pricing';
/** The fixture acts as the authenticated relay, opening only with the supplied existing API credential. */
export function openTestPrivateRequest(body:any,url:string,headers:NonNullable<Parameters<typeof fetch>[1]>['headers']):any{
 const credential=new Headers(headers).get('authorization')??'';
 const secret=credential.slice(credential.indexOf(':')+1);
 const req={body,originalUrl:new URL(url).pathname};
 openPrivateAuthenticatedRequest(req,secret);
 return req.body;
}
