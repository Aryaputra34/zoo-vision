import cv2
from ultralytics import YOLO
import supervision as sv

def main():
    img_path = r"c:\Users\Magnet Busdev-2\Documents\temp\zoo-monitor\scratch\restoran_26_53_raw.jpg"
    frame = cv2.imread(img_path)
    h, w = frame.shape[:2]
    
    # User's coordinates:
    # start: [1.00, 0.48], end: [0.82, 0.17]
    sz_x1 = int(min(0.82, 1.00) * w)
    sz_x2 = int(max(0.82, 1.00) * w)
    sz_y1 = int(min(0.17, 0.48) * h)
    sz_y2 = int(max(0.17, 0.48) * h)
    
    print(f"Shadow Zone Pixels: x=[{sz_x1}, {sz_x2}], y=[{sz_y1}, {sz_y2}]")
    
    base_conf = 0.20
    shadow_conf = 0.11
    
    for m_name in ["yolo26m.pt", "yolo26l.pt"]:
        print(f"\n--- Testing {m_name} with Zone-Adaptive Thresholding ---")
        model = YOLO(m_name)
        # Run inference at lowest threshold (0.11)
        res = model(frame, classes=[0], conf=shadow_conf, imgsz=1920, verbose=False)[0]
        
        accepted_boxes = []
        shadow_accepted = 0
        
        for b in res.boxes:
            c = float(b.conf[0])
            bx = [int(x) for x in b.xyxy[0].tolist()]
            # Center of detection
            cx = (bx[0] + bx[2]) / 2
            cy = (bx[1] + bx[3]) / 2
            
            # Check if inside shadow zone
            is_in_shadow = (sz_x1 <= cx <= sz_x2 and sz_y1 <= cy <= sz_y2)
            
            if is_in_shadow:
                if c >= shadow_conf:
                    accepted_boxes.append((b, c, bx, True))
                    shadow_accepted += 1
            else:
                if c >= base_conf:
                    accepted_boxes.append((b, c, bx, False))
                    
        print(f"Total Accepted Detections: {len(accepted_boxes)}")
        print(f"Detections inside Bamboo Shadow Zone: {shadow_accepted}")
        for b, c, bx, in_s in accepted_boxes:
            if in_s:
                print(f"  [Bamboo Zone] conf={c:.3f}, box={bx}")
                
        # Save visualization
        annotated = frame.copy()
        # Draw shadow zone border
        cv2.rectangle(annotated, (sz_x1, sz_y1), (sz_x2, sz_y2), (0, 255, 255), 2)
        cv2.putText(annotated, f"SHADOW BOOST ZONE (conf >= {shadow_conf})", (sz_x1 - 250, sz_y1 - 10),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 255), 2)
        for b, c, bx, in_s in accepted_boxes:
            color = (0, 255, 255) if in_s else (0, 255, 0)
            cv2.rectangle(annotated, (bx[0], bx[1]), (bx[2], bx[3]), color, 2)
            cv2.putText(annotated, f"p {c:.2f}", (bx[0], bx[1] - 5), cv2.FONT_HERSHEY_SIMPLEX, 0.4, color, 1)
            
        out_name = f"scratch/adaptive_zone_{m_name.split('.')[0]}.jpg"
        cv2.imwrite(out_name, annotated)
        print(f"Saved preview: {out_name}")

if __name__ == "__main__":
    main()
