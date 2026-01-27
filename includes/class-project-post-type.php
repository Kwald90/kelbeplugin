<?php
/**
 * Project Post Type
 *
 * Registers and manages the kpt_project custom post type
 *
 * @package Kelbe_Project_Tracker
 */

// Exit if accessed directly
if (!defined('ABSPATH')) {
    exit;
}

/**
 * Project Post Type class
 */
class KPT_Project_Post_Type {
    
    /**
     * Single instance
     *
     * @var KPT_Project_Post_Type
     */
    private static $instance = null;
    
    /**
     * Get instance
     *
     * @return KPT_Project_Post_Type
     */
    public static function get_instance() {
        if (null === self::$instance) {
            self::$instance = new self();
        }
        return self::$instance;
    }
    
    /**
     * Constructor
     */
    private function __construct() {
        add_action('init', array($this, 'register'));
        add_action('add_meta_boxes', array($this, 'add_meta_boxes'));
        add_action('save_post_kpt_project', array($this, 'save_meta'), 10, 2);
    }
    
    /**
     * Register post type
     */
    public static function register() {
        $labels = array(
            'name' => __('Projects', 'kelbe-project-tracker'),
            'singular_name' => __('Project', 'kelbe-project-tracker'),
            'menu_name' => __('Projects', 'kelbe-project-tracker'),
            'add_new' => __('Add New', 'kelbe-project-tracker'),
            'add_new_item' => __('Add New Project', 'kelbe-project-tracker'),
            'edit_item' => __('Edit Project', 'kelbe-project-tracker'),
            'new_item' => __('New Project', 'kelbe-project-tracker'),
            'view_item' => __('View Project', 'kelbe-project-tracker'),
            'search_items' => __('Search Projects', 'kelbe-project-tracker'),
            'not_found' => __('No projects found', 'kelbe-project-tracker'),
            'not_found_in_trash' => __('No projects found in trash', 'kelbe-project-tracker'),
        );
        
        $args = array(
            'labels' => $labels,
            'public' => false,
            'show_ui' => true,
            'show_in_menu' => true,
            'menu_icon' => 'dashicons-hammer',
            'menu_position' => 5,
            'capability_type' => 'post',
            'hierarchical' => false,
            'supports' => array('title'),
            'has_archive' => false,
            'rewrite' => false,
            'query_var' => false,
        );
        
        register_post_type('kpt_project', $args);
    }
    
    /**
     * Add meta boxes
     */
    public function add_meta_boxes() {
        add_meta_box(
            'kpt_project_details',
            __('Project Details', 'kelbe-project-tracker'),
            array($this, 'render_details_meta_box'),
            'kpt_project',
            'normal',
            'high'
        );
        
        add_meta_box(
            'kpt_project_customer',
            __('Customer Information', 'kelbe-project-tracker'),
            array($this, 'render_customer_meta_box'),
            'kpt_project',
            'normal',
            'high'
        );
        
        add_meta_box(
            'kpt_project_status',
            __('Project Status', 'kelbe-project-tracker'),
            array($this, 'render_status_meta_box'),
            'kpt_project',
            'side',
            'high'
        );
    }
    
    /**
     * Render details meta box
     */
    public function render_details_meta_box($post) {
        wp_nonce_field('kpt_project_meta', 'kpt_project_meta_nonce');
        
        $address = get_post_meta($post->ID, '_kpt_address', true);
        $city = get_post_meta($post->ID, '_kpt_city', true);
        $postal_code = get_post_meta($post->ID, '_kpt_postal_code', true);
        $start_date = get_post_meta($post->ID, '_kpt_start_date', true);
        $target_date = get_post_meta($post->ID, '_kpt_target_date', true);
        ?>
        <table class="form-table">
            <tr>
                <th><label for="kpt_address"><?php _e('Address', 'kelbe-project-tracker'); ?></label></th>
                <td><input type="text" id="kpt_address" name="kpt_address" value="<?php echo esc_attr($address); ?>" class="widefat" /></td>
            </tr>
            <tr>
                <th><label for="kpt_city"><?php _e('City', 'kelbe-project-tracker'); ?></label></th>
                <td><input type="text" id="kpt_city" name="kpt_city" value="<?php echo esc_attr($city); ?>" class="regular-text" /></td>
            </tr>
            <tr>
                <th><label for="kpt_postal_code"><?php _e('Postal Code', 'kelbe-project-tracker'); ?></label></th>
                <td><input type="text" id="kpt_postal_code" name="kpt_postal_code" value="<?php echo esc_attr($postal_code); ?>" class="regular-text" /></td>
            </tr>
            <tr>
                <th><label for="kpt_start_date"><?php _e('Start Date', 'kelbe-project-tracker'); ?></label></th>
                <td><input type="date" id="kpt_start_date" name="kpt_start_date" value="<?php echo esc_attr($start_date); ?>" class="regular-text" /></td>
            </tr>
            <tr>
                <th><label for="kpt_target_date"><?php _e('Target Completion Date', 'kelbe-project-tracker'); ?></label></th>
                <td><input type="date" id="kpt_target_date" name="kpt_target_date" value="<?php echo esc_attr($target_date); ?>" class="regular-text" /></td>
            </tr>
        </table>
        <?php
    }
    
    /**
     * Render customer meta box
     */
    public function render_customer_meta_box($post) {
        $customer_name = get_post_meta($post->ID, '_kpt_customer_name', true);
        $customer_email = get_post_meta($post->ID, '_kpt_customer_email', true);
        $customer_phone = get_post_meta($post->ID, '_kpt_customer_phone', true);
        ?>
        <table class="form-table">
            <tr>
                <th><label for="kpt_customer_name"><?php _e('Customer Name', 'kelbe-project-tracker'); ?></label></th>
                <td><input type="text" id="kpt_customer_name" name="kpt_customer_name" value="<?php echo esc_attr($customer_name); ?>" class="widefat" /></td>
            </tr>
            <tr>
                <th><label for="kpt_customer_email"><?php _e('Customer Email', 'kelbe-project-tracker'); ?></label></th>
                <td><input type="email" id="kpt_customer_email" name="kpt_customer_email" value="<?php echo esc_attr($customer_email); ?>" class="widefat" /></td>
            </tr>
            <tr>
                <th><label for="kpt_customer_phone"><?php _e('Customer Phone', 'kelbe-project-tracker'); ?></label></th>
                <td><input type="tel" id="kpt_customer_phone" name="kpt_customer_phone" value="<?php echo esc_attr($customer_phone); ?>" class="regular-text" /></td>
            </tr>
        </table>
        <?php
    }
    
    /**
     * Render status meta box
     */
    public function render_status_meta_box($post) {
        $current_stage = get_post_meta($post->ID, '_kpt_current_stage', true);
        $project_status = get_post_meta($post->ID, '_kpt_project_status', true);
        
        if (empty($current_stage)) {
            $current_stage = 1;
        }
        if (empty($project_status)) {
            $project_status = 'planning';
        }
        ?>
        <p>
            <label for="kpt_current_stage"><strong><?php _e('Current Stage', 'kelbe-project-tracker'); ?></strong></label><br/>
            <select id="kpt_current_stage" name="kpt_current_stage" class="widefat">
                <option value="1" <?php selected($current_stage, 1); ?>><?php _e('1. Pre-Construction', 'kelbe-project-tracker'); ?></option>
                <option value="2" <?php selected($current_stage, 2); ?>><?php _e('2. Demolition', 'kelbe-project-tracker'); ?></option>
                <option value="3" <?php selected($current_stage, 3); ?>><?php _e('3. Rough-In', 'kelbe-project-tracker'); ?></option>
                <option value="4" <?php selected($current_stage, 4); ?>><?php _e('4. Finishing', 'kelbe-project-tracker'); ?></option>
                <option value="5" <?php selected($current_stage, 5); ?>><?php _e('5. Final Touches', 'kelbe-project-tracker'); ?></option>
                <option value="6" <?php selected($current_stage, 6); ?>><?php _e('6. Handover', 'kelbe-project-tracker'); ?></option>
            </select>
        </p>
        <p>
            <label for="kpt_project_status"><strong><?php _e('Project Status', 'kelbe-project-tracker'); ?></strong></label><br/>
            <select id="kpt_project_status" name="kpt_project_status" class="widefat">
                <option value="planning" <?php selected($project_status, 'planning'); ?>><?php _e('Planning', 'kelbe-project-tracker'); ?></option>
                <option value="in_progress" <?php selected($project_status, 'in_progress'); ?>><?php _e('In Progress', 'kelbe-project-tracker'); ?></option>
                <option value="on_hold" <?php selected($project_status, 'on_hold'); ?>><?php _e('On Hold', 'kelbe-project-tracker'); ?></option>
                <option value="completed" <?php selected($project_status, 'completed'); ?>><?php _e('Completed', 'kelbe-project-tracker'); ?></option>
            </select>
        </p>
        <?php
    }
    
    /**
     * Save meta data
     */
    public function save_meta($post_id, $post) {
        // Check nonce
        if (!isset($_POST['kpt_project_meta_nonce']) || !wp_verify_nonce($_POST['kpt_project_meta_nonce'], 'kpt_project_meta')) {
            return;
        }
        
        // Check autosave
        if (defined('DOING_AUTOSAVE') && DOING_AUTOSAVE) {
            return;
        }
        
        // Check permissions
        if (!current_user_can('edit_post', $post_id)) {
            return;
        }
        
        // Save fields
        $fields = array(
            'kpt_address' => '_kpt_address',
            'kpt_city' => '_kpt_city',
            'kpt_postal_code' => '_kpt_postal_code',
            'kpt_customer_name' => '_kpt_customer_name',
            'kpt_customer_email' => '_kpt_customer_email',
            'kpt_customer_phone' => '_kpt_customer_phone',
            'kpt_start_date' => '_kpt_start_date',
            'kpt_target_date' => '_kpt_target_date',
            'kpt_current_stage' => '_kpt_current_stage',
            'kpt_project_status' => '_kpt_project_status',
        );
        
        foreach ($fields as $field => $meta_key) {
            if (isset($_POST[$field])) {
                update_post_meta($post_id, $meta_key, sanitize_text_field($_POST[$field]));
            }
        }
    }
}
