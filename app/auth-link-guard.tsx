'use client';
import {useEffect} from 'react';
import {hasAuthLink} from '@/lib/auth-callback';
export function AuthLinkGuard(){useEffect(()=>{if(location.pathname!=='/auth/complete'&&hasAuthLink(location.href))location.replace('/auth/complete'+location.search+location.hash)},[]);return null}
