import cv2
import numpy as np

def main():
    img_path = r"c:\Users\Magnet Busdev-2\Documents\temp\zoo-monitor\scratch\restoran_26_53_raw.jpg"
    img = cv2.imread(img_path)
    if img is None:
        print("Image not found")
        return
        
    h, w = img.shape[:2]
    overlay = img.copy()
    
    # Coordinates: x from 0.50 to 1.00, y from 0.15 to 0.70
    px1, py1 = int(0.50 * w), int(0.15 * h)
    px2, py2 = int(1.00 * w), int(0.70 * h)
    
    # Draw tinted rectangle over the zone
    cv2.rectangle(overlay, (px1, py1), (px2, py2), (255, 120, 0), -1) # Blue-orange tint
    img = cv2.addWeighted(overlay, 0.35, img, 0.65, 0)
    
    # Draw clear border
    cv2.rectangle(img, (px1, py1), (px2, py2), (0, 255, 255), 3) # Bright yellow border
    
    # Draw reference grid lines (every 25%)
    for pct in [0.25, 0.50, 0.75]:
        # Vertical
        x = int(pct * w)
        cv2.line(img, (x, 0), (x, h), (100, 100, 100), 1, cv2.LINE_AA)
        cv2.putText(img, f"x={pct:.2f} ({int(pct*100)}%)", (x + 5, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (200, 200, 200), 1)
        
        # Horizontal
        y = int(pct * h)
        cv2.line(img, (0, y), (w, y), (100, 100, 100), 1, cv2.LINE_AA)
        cv2.putText(img, f"y={pct:.2f} ({int(pct*100)}%)", (10, y - 8), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (200, 200, 200), 1)
        
    # Add Origin label at top left
    cv2.putText(img, "ORIGIN (x=0.0, y=0.0) [Top-Left]", (20, 70), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 255, 0), 2)
    cv2.putText(img, "(x=1.0, y=1.0) [Bottom-Right]", (w - 380, h - 30), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 255, 0), 2)

    # Label the highlighted zone
    cv2.putText(img, "TOP-RIGHT SHADOW ZONE", (px1 + 30, py1 + 60), cv2.FONT_HERSHEY_SIMPLEX, 1.0, (0, 255, 255), 2)
    cv2.putText(img, "x: 0.50 -> 1.00 (Right Half)", (px1 + 30, py1 + 105), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255, 255, 255), 2)
    cv2.putText(img, "y: 0.15 -> 0.70 (Below ceiling down to middle tables)", (px1 + 30, py1 + 140), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255, 255, 255), 2)
    
    out_path = r"c:\Users\Magnet Busdev-2\Documents\temp\zoo-monitor\scratch\coordinate_explanation.jpg"
    cv2.imwrite(out_path, img)
    print("Saved guide to", out_path)

if __name__ == "__main__":
    main()
