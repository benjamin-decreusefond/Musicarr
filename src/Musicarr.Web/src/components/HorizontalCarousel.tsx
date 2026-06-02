import { useRef } from 'react';
import { Box, IconButton, Typography } from '@mui/material';
import { ChevronLeft as ChevronLeftIcon, ChevronRight as ChevronRightIcon } from '@mui/icons-material';

interface HorizontalCarouselProps {
  title: string;
  children: React.ReactNode;
  itemCount: number;
}

const SCROLL_AMOUNT = 320;

export default function HorizontalCarousel({ title, children, itemCount }: HorizontalCarouselProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  const scroll = (direction: 'left' | 'right') => {
    if (!scrollRef.current) return;
    scrollRef.current.scrollBy({ left: direction === 'right' ? SCROLL_AMOUNT : -SCROLL_AMOUNT, behavior: 'smooth' });
  };

  if (itemCount === 0) return null;

  return (
    <Box sx={{ mb: 4 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1.5 }}>
        <Typography variant="h6" fontWeight={700}>{title}</Typography>
        <Box>
          <IconButton size="small" onClick={() => scroll('left')} aria-label="scroll left">
            <ChevronLeftIcon />
          </IconButton>
          <IconButton size="small" onClick={() => scroll('right')} aria-label="scroll right">
            <ChevronRightIcon />
          </IconButton>
        </Box>
      </Box>
      <Box
        ref={scrollRef}
        sx={{
          display: 'flex',
          flexDirection: 'row',
          gap: 2,
          overflowX: 'auto',
          scrollbarWidth: 'none',
          '&::-webkit-scrollbar': { display: 'none' },
          pb: 1,
        }}
      >
        {children}
      </Box>
    </Box>
  );
}
