import * as Device from 'expo-device';
import React from 'react';
import { Text, View } from 'react-native';
import config from './config';

if (!__DEV__ || Device.isDevice || config.relay !== 'http://127.0.0.1:18551') throw Error('isolated_native_build_required');
// This entry is selected only by the explicit simulator Metro configuration.
// Reject every external fetch, including unrelated background registrations.
function requireLocalUrl(value:string, socket=false):void {
 const url=new URL(value);
 const relay=url.hostname==='127.0.0.1'&&url.port==='18551';
 const metro=['127.0.0.1','localhost'].includes(url.hostname)&&url.port==='8083';
 if (!(relay||metro) || !(url.protocol==='http:'||(socket&&metro&&url.protocol==='ws:')))
   throw Error('isolated_native_external_network_refused');
}
// Fetch, ethers' XHR transport and background sockets all stay on loopback.
const originalOpen=XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open=function(method:string,url:string|URL,async:boolean=true,user?:string|null,password?:string|null){
 requireLocalUrl(String(url));return originalOpen.call(this,method,String(url),async,user,password);
};
const LocalSocket=globalThis.WebSocket;
globalThis.WebSocket=class extends LocalSocket {
 constructor(url:string|URL,protocols?:string|string[]){requireLocalUrl(String(url),true);super(url,protocols);}
};
const networkFetch=globalThis.fetch.bind(globalThis);
globalThis.fetch=((input:RequestInfo | URL,init?:RequestInit)=>{
 requireLocalUrl(typeof input==='string'?input:input instanceof URL?input.href:input.url);
 return networkFetch(input,init);
}) as typeof fetch;
const Relay=require('../../../src/services/RelayAPIService').default as typeof import('../../../src/services/RelayAPIService').default;
const History=require('../../../src/core/history/TransactionHistoryService').default as typeof import('../../../src/core/history/TransactionHistoryService').default;
Relay.getUserId=async()=>config.userId;
// Keep the real recovery envelope/signing code, substituting only its transport.
Reflect.set(Relay,'getBackendUrl',async()=>config.relay);
Reflect.set(Relay,'makeAuthenticatedRequest',async(path:string,options:RequestInit={})=>{
 if(!path.startsWith('/v1/recourse/'))throw Error('isolated_native_route_refused');
 return fetch(config.relay+path,{...options,headers:{...options.headers,'content-type':'application/json',authorization:`Bearer ${config.fixtureToken}`}});
});
const Transactions=require('../../../src/core/wallet/TransactionService').default as typeof import('../../../src/core/wallet/TransactionService').default;
const {JsonRpcProvider}=require('ethers') as typeof import('ethers');
const localProvider=new JsonRpcProvider(`${config.relay}/rpc/one`,8453,{staticNetwork:true,batchMaxCount:1});
Transactions.providerFor=(chainId)=>{if(chainId!==8453)throw Error('isolated_chain_required');return localProvider;};
Reflect.set(Transactions,'getProvider',Transactions.providerFor);
Relay.recourseRequest=async(path,body)=>{
 const response=await fetch(`${config.relay}/v1/recourse/${path}`,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json',authorization:`Bearer ${config.fixtureToken}`},...(body===undefined?{}:{body:JSON.stringify(body)})});
 if(!response.ok)throw Error('recourse_request_refused');return response.json();
};
// The history adapter reads actual Transfer logs from the isolated contracts.
History.getTransactions=async(addresses,options)=>{
 const address=typeof addresses==='string'?addresses:addresses.Base;
 const response=await fetch(`${config.relay}/exercise/history?address=${encodeURIComponent(address)}&page=${options?.page??1}&limit=${options?.limit??50}`);
 if(!response.ok)throw Error('isolated_history_unavailable');return response.json();
};
const App=require('../../../App').default as React.ComponentType;
export default function IsolatedNativeApp():React.JSX.Element{
 return <View style={{flex:1}}><View style={{paddingTop:55,paddingBottom:6,backgroundColor:'#142d3c'}}><Text style={{color:'#fff',textAlign:'center'}}>ISOLATED RECOURSE · TEST FUNDS ONLY</Text></View><App/></View>;
}
