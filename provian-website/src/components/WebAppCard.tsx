'use client'
// The web app (app.provian.ai) beside the store buttons, and the "Add your phone" link beside the
// App Store card. The site is English; these lines follow the visitor's browser language in the
// app's twelve languages, because they lead into the app, which speaks all twelve.
import { useEffect, useState } from 'react'
import { ArrowUpRight } from 'lucide-react'

export const WEB_APP_URL = 'https://app.provian.ai'
export const ADD_PHONE_URL = 'https://app.provian.ai/add-phone'

type Copy = { title: string; body: string; open: string; addPhoneLead: string; addPhone: string }

export const WEB_APP_COPY: Record<string, Copy> = {
  en: {
    title: 'In your browser',
    body: 'Use Provian on your computer: the same wallet and account as the phone app, unlocked with a passkey and your PIN.',
    open: 'Open in your browser',
    addPhoneLead: 'Already using Provian in your browser?',
    addPhone: 'Add your phone',
  },
  es: {
    title: 'En tu navegador',
    body: 'Usa Provian en tu computadora: la misma billetera y la misma cuenta que en la app del teléfono, desbloqueadas con una llave de acceso y tu PIN.',
    open: 'Abrir en tu navegador',
    addPhoneLead: '¿Ya usas Provian en tu navegador?',
    addPhone: 'Agregar tu teléfono',
  },
  fr: {
    title: 'Dans votre navigateur',
    body: 'Utilisez Provian sur votre ordinateur : le même portefeuille et le même compte que dans l’application mobile, déverrouillés avec une clé d’accès et votre code PIN.',
    open: 'Ouvrir dans votre navigateur',
    addPhoneLead: 'Vous utilisez déjà Provian dans votre navigateur ?',
    addPhone: 'Ajouter votre téléphone',
  },
  pt: {
    title: 'No seu navegador',
    body: 'Use o Provian no computador: a mesma carteira e a mesma conta do app do celular, desbloqueadas com uma chave de acesso e o seu PIN.',
    open: 'Abrir no navegador',
    addPhoneLead: 'Já usa o Provian no navegador?',
    addPhone: 'Adicionar seu telefone',
  },
  hi: {
    title: 'आपके ब्राउज़र में',
    body: 'अपने कंप्यूटर पर Provian इस्तेमाल करें: फ़ोन ऐप वाला ही वॉलेट और खाता, पासकी और आपके PIN से खुलता है।',
    open: 'ब्राउज़र में खोलें',
    addPhoneLead: 'क्या आप पहले से ब्राउज़र में Provian इस्तेमाल कर रहे हैं?',
    addPhone: 'अपना फ़ोन जोड़ें',
  },
  id: {
    title: 'Di browser Anda',
    body: 'Gunakan Provian di komputer Anda: dompet dan akun yang sama dengan aplikasi ponsel, dibuka dengan passkey dan PIN Anda.',
    open: 'Buka di browser',
    addPhoneLead: 'Sudah memakai Provian di browser?',
    addPhone: 'Tambahkan ponsel Anda',
  },
  sw: {
    title: 'Kwenye kivinjari chako',
    body: 'Tumia Provian kwenye kompyuta yako: pochi na akaunti ileile ya programu ya simu, inayofunguliwa kwa passkey na PIN yako.',
    open: 'Fungua kwenye kivinjari',
    addPhoneLead: 'Tayari unatumia Provian kwenye kivinjari?',
    addPhone: 'Ongeza simu yako',
  },
  tl: {
    title: 'Sa iyong browser',
    body: 'Gamitin ang Provian sa iyong computer: parehong wallet at account ng phone app, binubuksan gamit ang passkey at ang iyong PIN.',
    open: 'Buksan sa browser',
    addPhoneLead: 'Gumagamit ka na ba ng Provian sa browser?',
    addPhone: 'Idagdag ang phone mo',
  },
  vi: {
    title: 'Trên trình duyệt',
    body: 'Dùng Provian trên máy tính: cùng ví và cùng tài khoản với ứng dụng điện thoại, mở khóa bằng khóa truy cập và mã PIN của bạn.',
    open: 'Mở trên trình duyệt',
    addPhoneLead: 'Bạn đã dùng Provian trên trình duyệt?',
    addPhone: 'Thêm điện thoại của bạn',
  },
  ja: {
    title: 'ブラウザで',
    body: 'パソコンで Provian を使えます。スマートフォンアプリと同じウォレットとアカウントを、パスキーと PIN で開きます。',
    open: 'ブラウザで開く',
    addPhoneLead: 'すでにブラウザで Provian を使っていますか?',
    addPhone: 'スマートフォンを追加',
  },
  ko: {
    title: '브라우저에서',
    body: '컴퓨터에서 Provian을 사용하세요. 휴대폰 앱과 같은 지갑과 계정을 패스키와 PIN으로 엽니다.',
    open: '브라우저에서 열기',
    addPhoneLead: '이미 브라우저에서 Provian을 사용 중인가요?',
    addPhone: '휴대폰 추가',
  },
  zh: {
    title: '在浏览器中',
    body: '在电脑上使用 Provian：与手机应用相同的钱包和账户，用通行密钥和你的 PIN 解锁。',
    open: '在浏览器中打开',
    addPhoneLead: '已经在浏览器中使用 Provian？',
    addPhone: '添加你的手机',
  },
}

export function pickWebAppCopy(languages: readonly string[]): Copy {
  for (const tag of languages) {
    const base = tag.toLowerCase().split('-')[0]
    const lang = base === 'fil' ? 'tl' : base
    if (WEB_APP_COPY[lang]) return WEB_APP_COPY[lang]
  }
  return WEB_APP_COPY.en
}

function useWebAppCopy(): Copy {
  const [copy, setCopy] = useState<Copy>(WEB_APP_COPY.en)
  useEffect(() => {
    const langs = navigator.languages?.length ? navigator.languages : [navigator.language]
    setCopy(pickWebAppCopy(langs))
  }, [])
  return copy
}

export function WebAppCard({ className = 'glass flex flex-col p-7' }: { className?: string }) {
  const copy = useWebAppCopy()
  return (
    <div className={className}>
      <h2 className="font-display text-2xl font-semibold tracking-[-0.02em]">{copy.title}</h2>
      <p className="mt-3 flex-1 leading-7 text-text-secondary">{copy.body}</p>
      <a href={WEB_APP_URL} className="btn-primary mt-6 w-full">
        {copy.open}
        <ArrowUpRight size={16} />
      </a>
    </div>
  )
}

export function AddYourPhoneLink({ className = 'mt-4 text-sm text-text-secondary' }: { className?: string }) {
  const copy = useWebAppCopy()
  return (
    <p className={className}>
      {copy.addPhoneLead}{' '}
      <a href={ADD_PHONE_URL} className="text-provian-blue-bright underline">
        {copy.addPhone}
      </a>
    </p>
  )
}
