import { cn } from "@/lib/utils";

interface BrandLogoProps {
  className?: string;
  /** 是否带有 Squircle 倒角底板 (默认 true) */
  withPlate?: boolean;
}

export function BrandLogo({ className = "h-7 w-7", withPlate = true }: BrandLogoProps) {
  return (
    <svg
      viewBox="0 0 1024 1024"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={cn("shrink-0 select-none", className)}
      aria-hidden="true"
    >
      <defs>
        {/* 浅色模式底板渐变:象牙白到微暖奶油 */}
        <linearGradient id="brand-plate-light" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#FDFBF7" />
          <stop offset="100%" stopColor="#EBDDCB" />
        </linearGradient>
        {/* 深色模式底板渐变:暖炭灰 */}
        <linearGradient id="brand-plate-dark" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#3E3630" />
          <stop offset="100%" stopColor="#221E1C" />
        </linearGradient>
      </defs>

      {withPlate && (
        <g>
          {/* Squircle 圆角底板 */}
          <rect
            width="1024"
            height="1024"
            rx="228"
            ry="228"
            className="fill-[url(#brand-plate-light)] dark:fill-[url(#brand-plate-dark)]"
          />
          {/* 顶边 1px 微反光边缘倒角 */}
          <rect
            x="4"
            y="4"
            width="1016"
            height="1016"
            rx="224"
            ry="224"
            fill="none"
            className="stroke-white/60 dark:stroke-white/10"
            strokeWidth="8"
          />
        </g>
      )}

      {/* G 外环 (从 36° 顺时针环绕到 324°) */}
      <path
        d="M 709 686 A 276 276 0 1 1 709 362"
        fill="none"
        strokeWidth="146"
        strokeLinecap="round"
        className="stroke-[#3A2E27] dark:stroke-[#E8DFD5]"
      />

      {/* 陶土橘穿透/转发箭头 */}
      <line
        x1="486"
        y1="524"
        x2="748"
        y2="524"
        stroke="hsl(var(--primary))"
        strokeWidth="114"
        strokeLinecap="round"
      />
      <polygon
        points="908,524 768,411 768,637"
        fill="hsl(var(--primary))"
      />
    </svg>
  );
}
