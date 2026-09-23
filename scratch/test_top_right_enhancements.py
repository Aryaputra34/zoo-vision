import os
import cv2
import numpy as np
from ultralytics import YOLO
import supervision as sv

def main():
    img_path = r"c:\Users\Magnet Busdev-2\Documents\temp\zoo-monitor\scratch\restoran_26_53_raw.jpg"
    frame = cv2.imread(img_path)
    h, w = frame.shape[:2]
    
    # Define top-right ROI: x from 0.5 to 1.0, y from 0.1 to 0.7
    x1, y1 = int(w * 0.5), int(h * 0.1)
    x2, y2 = w, int(h * 0.7)
    crop = frame[y1:y2, x1:x2].copy()
    
    model = YOLO("yolo26m.pt")
    
    print("--- 1. Baseline Detection on Crop (conf=0.20) ---")
    res1 = model(crop, classes=[0], conf=0.20, imgsz=1024, verbose=False)[0]
    dets1 = sv.Detections.from_ultralytics(res1)
    print(f"Crop baseline detections: {len(dets1)}")
    
    print("\n--- 2. Low-Confidence on Crop (conf=0.10) ---")
    res2 = model(crop, classes=[0], conf=0.10, imgsz=1024, verbose=False)[0]
    dets2 = sv.Detections.from_ultralytics(res2)
    print(f"Crop low-conf (0.10) detections: {len(dets2)}")
    for i, (b, c) in enumerate(zip(dets2.xyxy, dets2.confidence)):
        print(f"  Det {i}: conf={c:.3f}, box={[int(x) for x in b]}")
        
    print("\n--- 3. CLAHE Contrast Enhanced Crop ---")
    # Apply CLAHE to L channel of LAB color space
    lab = cv2.cvtColor(crop, cv2.COLOR_BGR2LAB)
    l, a, b = cv2.split(lab)
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    cl = clahe.apply(l)
    enhanced = cv2.cvtColor(cv2.merge((cl, a, b)), cv2.COLOR_LAB2BGR)
    
    res3 = model(enhanced, classes=[0], conf=0.12, imgsz=1024, verbose=False)[0]
    dets3 = sv.Detections.from_ultralytics(res3)
    print(f"Crop CLAHE + conf=0.12 detections: {len(dets3)}")
    
    # Save visual
    box_ann = sv.BoxAnnotator(thickness=2)
    lbl_ann = sv.LabelAnnotator(text_scale=0.4, text_thickness=1)
    ann2 = box_ann.annotate(crop.copy(), detections=dets2)
    ann2 = lbl_ann.annotate(ann2, detections=dets2, labels=[f"p {c:.2f}" for c in dets2.confidence])
    cv2.imwrite(r"c:\Users\Magnet Busdev-2\Documents\temp\zoo-monitor\scratch\top_right_lowconf.jpg", ann2)
    
    ann3 = box_ann.annotate(enhanced.copy(), detections=dets3)
    ann3 = lbl_ann.annotate(ann3, detections=dets3, labels=[f"p {c:.2f}" for c in dets3.confidence])
    cv2.imwrite(r"c:\Users\Magnet Busdev-2\Documents\temp\zoo-monitor\scratch\top_right_clahe.jpg", ann3)
    print("Saved previews to scratch/")

if __name__ == "__main__":
    main()
