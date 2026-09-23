import cv2
from ultralytics import YOLO
import supervision as sv

def main():
    img_path = r"c:\Users\Magnet Busdev-2\Documents\temp\zoo-monitor\scratch\restoran_26_53_raw.jpg"
    frame = cv2.imread(img_path)
    if frame is None:
        print("Image not found")
        return
        
    h, w = frame.shape[:2]
    
    # User's coordinates:
    # start: [0.81, 0.14]
    # end:   [0.98, 0.48]
    x1, y1 = int(0.81 * w), int(0.14 * h)
    x2, y2 = int(0.98 * w), int(0.48 * h)
    
    print(f"User Box Pixels: x=[{x1}, {x2}], y=[{y1}, {y2}] ({x2-x1}x{y2-y1} px)")
    
    # Crop the exact region
    crop = frame[y1:y2, x1:x2].copy()
    cv2.imwrite(r"c:\Users\Magnet Busdev-2\Documents\temp\zoo-monitor\scratch\user_bamboo_table_crop.jpg", crop)
    
    # Draw box on full frame
    full_annotated = frame.copy()
    cv2.rectangle(full_annotated, (x1, y1), (x2, y2), (0, 0, 255), 3) # Red border
    cv2.putText(full_annotated, "USER TARGET ZONE [0.81, 0.14] -> [0.98, 0.48]", (x1 - 320, y1 - 15), 
                cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 0, 255), 2)
    cv2.imwrite(r"c:\Users\Magnet Busdev-2\Documents\temp\zoo-monitor\scratch\user_box_annotated.jpg", full_annotated)
    
    # Test YOLO on this exact crop
    model = YOLO("yolo26m.pt")
    res = model(crop, classes=[0], conf=0.10, imgsz=640, verbose=False)[0]
    dets = sv.Detections.from_ultralytics(res)
    print(f"\nDetections inside crop at conf=0.10: {len(dets)}")
    for i, (b, c) in enumerate(zip(dets.xyxy, dets.confidence)):
        print(f"  Person {i+1}: conf={c:.2f}, box={[int(x) for x in b]}")
        
    # Annotate crop
    box_ann = sv.BoxAnnotator(thickness=2)
    lbl_ann = sv.LabelAnnotator(text_scale=0.5, text_thickness=1)
    crop_ann = box_ann.annotate(crop.copy(), detections=dets)
    labels = [f"person {c:.2f}" for c in dets.confidence]
    crop_ann = lbl_ann.annotate(crop_ann, detections=dets, labels=labels)
    cv2.imwrite(r"c:\Users\Magnet Busdev-2\Documents\temp\zoo-monitor\scratch\user_crop_detections.jpg", crop_ann)
    print("Done!")

if __name__ == "__main__":
    main()
