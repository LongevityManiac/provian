import React from 'react';
import Svg, { Circle, Path } from 'react-native-svg';
import { COLORS } from '../constants/theme';

const lines = {
    home: 'M24 5L40 11V24C40 34 33 40 24 44C15 40 8 34 8 24V11Z',
    earn: 'M13 16L24 12L35 16V35H13Z M18 12V6M24 9V5M30 12V6M18 35V42M24 35V43M30 35V42M13 21H6M13 29H6M35 21H42M35 29H42',
    chat: 'M7 13L24 7L41 13V31H23L14 40V31H7Z',
    commons: 'M5 17L24 8L43 17 M7 42c0-6 4-9 8-9s8 3 8 9M25 42c0-6 4-9 8-9s8 3 8 9',
    promises: 'M10 12L24 6L38 12V42H10Z M16 21H32',
    proof: 'M11 9L21 5H30L38 13V43H11Z M30 5V13H38M17 21H28M17 27H23',
    computer: 'M11 31V14L24 9L37 14V31Z M5 38H43',
    agent: 'M24 6C25 16 32 23 42 24C32 25 25 32 24 42C23 32 16 25 6 24C16 23 23 16 24 6Z',
    send: 'M8 28V12L24 6L40 12V28 M8 34V42H40V34',
    receive: 'M8 26V12L24 6L40 12V26 M8 33V42H40V33',
    scan: 'M6 18V12L16 8 M32 8L42 12V18 M6 30V40H16 M32 40H42V30',
} as const;

const beams: Record<Exclude<ProvianIconName, 'agent'>, string> = {
    home: 'M24 14V32',
    earn: 'M19 25l4 4 7-8',
    chat: 'M24 15V24',
    commons: 'M24 13V20',
    promises: 'M15 33c2-5 4 4 6 0s4-5 6 0 3 2 6-1',
    proof: 'M27.8 35l2.2 2.2 4.2-4.4',
    computer: 'M24 16V25',
    send: 'M24 36V17M16 25l8-8 8 8',
    receive: 'M24 16V35M16 27l8 8 8-8',
    scan: 'M13 24H35',
};

export type ProvianIconName = keyof typeof lines;

export default function ProvianIcon({ name, size = 24, color, selected = false, connected = false, surface = COLORS.background }: {
    name: ProvianIconName;
    size?: number;
    color?: string;
    selected?: boolean;
    connected?: boolean;
    surface?: string;
}) {
    const stroke = color ?? (selected ? COLORS.primary : COLORS.textSecondary);
    const beam = selected ? COLORS.warning : stroke;
    const filledComputer = name === 'computer' && connected;
    return (
        <Svg width={size} height={size} viewBox="0 0 48 48" strokeWidth={2.5}
            strokeLinecap="round" strokeLinejoin="round" fill="none" accessible={false}>
            {filledComputer
                ? <><Path d="M11 31V14L24 9L37 14V31Z" fill={stroke} stroke={stroke} /><Path d="M5 38H43" stroke={stroke} /></>
                : <Path d={lines[name]} stroke={stroke} />}
            {name === 'commons' && <><Circle cx={15} cy={26} r={4} stroke={stroke} /><Circle cx={33} cy={26} r={4} stroke={stroke} /></>}
            {name === 'proof' && <Circle cx={31} cy={35} r={7} fill={surface} stroke={stroke} />}
            {name === 'agent' ? <Circle cx={38} cy={10} r={2.5} stroke={beam} />
                : <Path d={filledComputer ? 'M18 21l4 4 8-9' : beams[name]} stroke={filledComputer ? surface : beam} />}
        </Svg>
    );
}
