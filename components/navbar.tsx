
'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { FC } from 'react';

interface NavbarProps { 
  orientation?: 'horizontal' | 'vertical';
  routes: { title: string, path: string }[];
}

export const Navbar: FC<NavbarProps> = ({ routes, orientation = 'horizontal' }) => {

  const pathName = usePathname();

  return (
    <nav className="bg-gray-800 p-4">
      <div className={`container mx-auto flex items-center justify-between ${orientation === 'vertical' ? 'flex-col' : 'flex-row'}`}> 
        { routes.map((route) => (
          <Link 
            key={route.path} 
            href={route.path}
            className={`text-white px-3 py-2 rounded-md text-sm font-medium ${
              pathName === route.path ? 'bg-gray-900' : 'hover:bg-gray-700'
            }`}
          >
            {route.title}
          </Link>
        )) }
      </div>
    </nav>)
};