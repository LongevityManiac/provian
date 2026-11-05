import admin from 'firebase-admin';
import { scriptDb } from './lib/script-db';
admin.initializeApp();
const db = scriptDb();
Promise.all([
  db.collection('agent_wallets').where('platform', '==', 'k6-loadtest').count().get(),
  db.collection('provenance_envelopes').count().get(),
  db.collection('pvt_accrual').count().get(),
  db.collection('pe_history').count().get(),
]).then(([aw, pe, pvt, peh]) => {
  console.log('k6 agent_wallets:', aw.data().count);
  console.log('provenance_envelopes:', pe.data().count);
  console.log('pvt_accrual:', pvt.data().count);
  console.log('pe_history:', peh.data().count);
});
